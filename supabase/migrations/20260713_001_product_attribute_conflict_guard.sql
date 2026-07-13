-- RAP-A2: preserve existing critical catalog facts during automated enrichment.

create table if not exists public.product_attribute_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.catalog_products(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  product_code text not null,
  field_name text not null check (field_name in ('description', 'origin', 'hs_code', 'weight_kg', 'ean')),
  existing_value text not null,
  incoming_value text not null,
  normalized_incoming_value text not null,
  source_type text not null,
  source_reference text,
  status text not null default 'pending_review' check (status in ('pending_review', 'resolved', 'ignored')),
  detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  detection_count integer not null default 1 check (detection_count > 0),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolution_note text
);

create unique index if not exists uq_product_attribute_conflicts_pending_attempt
  on public.product_attribute_conflicts (
    organization_id,
    product_id,
    field_name,
    normalized_incoming_value
  )
  where status = 'pending_review';

create index if not exists idx_product_attribute_conflicts_product_status
  on public.product_attribute_conflicts (organization_id, product_id, status, detected_at desc);

alter table public.product_attribute_conflicts enable row level security;

drop policy if exists product_attribute_conflicts_admin_select_org on public.product_attribute_conflicts;
create policy product_attribute_conflicts_admin_select_org
on public.product_attribute_conflicts
for select
using (
  public.current_profile_role() in ('admin', 'superadmin')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists product_attribute_conflicts_admin_update_org on public.product_attribute_conflicts;
create policy product_attribute_conflicts_admin_update_org
on public.product_attribute_conflicts
for update
using (
  public.current_profile_role() in ('admin', 'superadmin')
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() in ('admin', 'superadmin')
  and organization_id = public.current_profile_org_id()
);

grant select on public.product_attribute_conflicts to authenticated;
grant update (status, resolved_at, resolved_by, resolution_note)
  on public.product_attribute_conflicts to authenticated;
grant select, insert, update on public.product_attribute_conflicts to service_role;

create or replace function public.normalize_product_conflict_value(
  input_field_name text,
  input_value text
)
returns text
language sql
immutable
set search_path = public
as $$
  select case lower(trim(coalesce(input_field_name, '')))
    when 'ean' then regexp_replace(coalesce(input_value, ''), '[^0-9]', '', 'g')
    when 'hs_code' then upper(regexp_replace(trim(coalesce(input_value, '')), '[^[:alnum:]]', '', 'g'))
    when 'origin' then upper(regexp_replace(trim(coalesce(input_value, '')), '\s+', ' ', 'g'))
    when 'weight_kg' then case
      when trim(coalesce(input_value, '')) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
        then (trim(input_value)::numeric)::text
      else trim(coalesce(input_value, ''))
    end
    else lower(regexp_replace(trim(coalesce(input_value, '')), '\s+', ' ', 'g'))
  end;
$$;

create or replace function public.apply_catalog_product_enrichment_guarded(
  input_rows jsonb,
  input_source_type text,
  input_source_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_product public.catalog_products%rowtype;
  v_org_id uuid;
  v_brand_id uuid;
  v_product_code text;
  v_source_type text := nullif(trim(coalesce(input_source_type, '')), '');
  v_source_reference text;
  v_current text;
  v_incoming text;
  v_field text;
  v_applied integer := 0;
  v_unchanged integer := 0;
  v_conflicts integer := 0;
  v_updated integer := 0;
  v_conflict_fields text[];
  v_affected_product_ids uuid[] := array[]::uuid[];
begin
  if jsonb_typeof(input_rows) <> 'array' then
    raise exception 'Catalog enrichment rows must be a JSON array';
  end if;

  if v_source_type is null then
    raise exception 'Catalog enrichment source type is required';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and coalesce(public.current_profile_role(), '') <> 'superadmin' then
    raise exception 'Catalog enrichment guard requires service role or superadmin';
  end if;

  for v_row in select value from jsonb_array_elements(input_rows)
  loop
    v_org_id := nullif(v_row->>'organization_id', '')::uuid;
    v_brand_id := nullif(v_row->>'brand_id', '')::uuid;
    v_product_code := trim(coalesce(v_row->>'product_code', ''));
    v_source_reference := coalesce(nullif(trim(v_row->>'source_reference'), ''), nullif(trim(input_source_reference), ''));

    if v_org_id is null or v_brand_id is null or v_product_code = '' then
      raise exception 'Catalog enrichment row requires organization_id, brand_id, and product_code';
    end if;

    if coalesce(auth.role(), '') <> 'service_role'
       and v_org_id <> public.current_profile_org_id() then
      raise exception 'Cross-organization catalog enrichment is not allowed';
    end if;

    select cp.*
    into v_product
    from public.catalog_products cp
    where cp.organization_id = v_org_id
      and cp.brand_id = v_brand_id
      and cp.normalized_code = public.normalize_part_code(v_product_code)
    for update;

    if not found then
      raise exception 'Existing catalog product was not found for guarded enrichment: %', v_product_code;
    end if;

    v_conflict_fields := array[]::text[];

    foreach v_field in array array['description', 'origin', 'hs_code', 'weight_kg', 'ean']
    loop
      v_current := case v_field
        when 'description' then v_product.description
        when 'origin' then v_product.origin
        when 'hs_code' then v_product.hs_code
        when 'weight_kg' then v_product.weight_kg::text
        when 'ean' then v_product.ean
      end;
      v_incoming := nullif(trim(coalesce(v_row->>v_field, '')), '');

      if nullif(trim(coalesce(v_current, '')), '') is not null
         and v_incoming is not null
         and public.normalize_product_conflict_value(v_field, v_current)
             <> public.normalize_product_conflict_value(v_field, v_incoming) then
        insert into public.product_attribute_conflicts (
          organization_id,
          product_id,
          brand_id,
          product_code,
          field_name,
          existing_value,
          incoming_value,
          normalized_incoming_value,
          source_type,
          source_reference
        ) values (
          v_org_id,
          v_product.id,
          v_brand_id,
          v_product.product_code,
          v_field,
          v_current,
          v_incoming,
          public.normalize_product_conflict_value(v_field, v_incoming),
          v_source_type,
          v_source_reference
        )
        on conflict (organization_id, product_id, field_name, normalized_incoming_value)
          where status = 'pending_review'
        do update set
          existing_value = excluded.existing_value,
          last_detected_at = now(),
          detection_count = public.product_attribute_conflicts.detection_count + 1,
          source_type = excluded.source_type,
          source_reference = coalesce(excluded.source_reference, public.product_attribute_conflicts.source_reference);

        v_conflict_fields := array_append(v_conflict_fields, v_field);
        v_conflicts := v_conflicts + 1;
      end if;
    end loop;

    update public.catalog_products cp
    set description = case
          when nullif(trim(coalesce(cp.description, '')), '') is null then nullif(trim(v_row->>'description'), '')
          else cp.description
        end,
        origin = case
          when nullif(trim(coalesce(cp.origin, '')), '') is null then nullif(trim(v_row->>'origin'), '')
          else cp.origin
        end,
        hs_code = case
          when nullif(trim(coalesce(cp.hs_code, '')), '') is null then nullif(trim(v_row->>'hs_code'), '')
          else cp.hs_code
        end,
        weight_kg = case
          when cp.weight_kg is null then nullif(v_row->>'weight_kg', '')::numeric
          else cp.weight_kg
        end,
        ean = case
          when nullif(trim(coalesce(cp.ean, '')), '') is null then nullif(trim(v_row->>'ean'), '')
          else cp.ean
        end,
        oem_no = coalesce(nullif(trim(v_row->>'oem_no'), ''), cp.oem_no),
        vehicle = coalesce(nullif(trim(v_row->>'vehicle'), ''), cp.vehicle),
        image_url = coalesce(nullif(trim(v_row->>'image_url'), ''), cp.image_url),
        lifecycle_status = coalesce(nullif(trim(v_row->>'lifecycle_status'), ''), cp.lifecycle_status),
        lifecycle_note = coalesce(nullif(trim(v_row->>'lifecycle_note'), ''), cp.lifecycle_note),
        updated_at = now()
    where cp.id = v_product.id
      and (
        (nullif(trim(coalesce(cp.description, '')), '') is null and nullif(trim(v_row->>'description'), '') is not null)
        or (nullif(trim(coalesce(cp.origin, '')), '') is null and nullif(trim(v_row->>'origin'), '') is not null)
        or (nullif(trim(coalesce(cp.hs_code, '')), '') is null and nullif(trim(v_row->>'hs_code'), '') is not null)
        or (cp.weight_kg is null and nullif(trim(v_row->>'weight_kg'), '') is not null)
        or (nullif(trim(coalesce(cp.ean, '')), '') is null and nullif(trim(v_row->>'ean'), '') is not null)
        or (nullif(trim(v_row->>'oem_no'), '') is not null and cp.oem_no is distinct from nullif(trim(v_row->>'oem_no'), ''))
        or (nullif(trim(v_row->>'vehicle'), '') is not null and cp.vehicle is distinct from nullif(trim(v_row->>'vehicle'), ''))
        or (nullif(trim(v_row->>'image_url'), '') is not null and cp.image_url is distinct from nullif(trim(v_row->>'image_url'), ''))
        or (nullif(trim(v_row->>'lifecycle_status'), '') is not null and cp.lifecycle_status is distinct from nullif(trim(v_row->>'lifecycle_status'), ''))
        or (nullif(trim(v_row->>'lifecycle_note'), '') is not null and cp.lifecycle_note is distinct from nullif(trim(v_row->>'lifecycle_note'), ''))
      );

    get diagnostics v_updated = row_count;
    if v_updated > 0 then
      v_applied := v_applied + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;

    if cardinality(v_conflict_fields) > 0
       and not (v_product.id = any(v_affected_product_ids))
       and cardinality(v_affected_product_ids) < 50 then
      v_affected_product_ids := array_append(v_affected_product_ids, v_product.id);
    end if;
  end loop;

  return jsonb_build_object(
    'applied_count', v_applied,
    'unchanged_count', v_unchanged,
    'conflict_count', v_conflicts,
    'affected_product_ids', to_jsonb(v_affected_product_ids)
  );
end;
$$;

revoke all on function public.apply_catalog_product_enrichment_guarded(jsonb, text, text) from public;
grant execute on function public.apply_catalog_product_enrichment_guarded(jsonb, text, text) to service_role;

drop function if exists public.cloud_resolve_quote_line(text, text, text, numeric, numeric);

create function public.cloud_resolve_quote_line(
  input_code text,
  input_brand text default '',
  input_customer_type text default 'A',
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns table (
  found boolean,
  product_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  supplier_id uuid,
  supplier_name text,
  buy_price numeric,
  price_date date,
  sell_price numeric,
  notes text,
  has_product_conflict boolean,
  product_conflict_fields text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with requested_brand as (
    select b.id
    from public.brands b
    where b.organization_id = public.current_profile_org_id()
      and b.normalized_name = public.normalize_part_code(input_brand)
    limit 1
  ),
  catalog_exact as (
    select cp.id, cp.product_code, cp.normalized_code, cp.description, cp.oem_no,
      cp.hs_code, cp.origin, cp.weight_kg, cp.brand_id, b.name as brand
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    where cp.organization_id = public.current_profile_org_id()
      and (cp.normalized_code = public.normalize_part_code(input_code) or cp.normalized_oem = public.normalize_part_code(input_code))
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by
      case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      case when cp.normalized_code = public.normalize_part_code(input_code) then 0 else 1 end,
      case when cp.normalized_oem = public.normalize_part_code(input_code) then 0 else 1 end,
      b.name,
      cp.product_code
    limit 1
  ),
  supplier_exact as (
    select null::uuid as id, sp.product_code, sp.normalized_code, sp.description, sp.oem_no,
      null::text as hs_code, null::text as origin, null::numeric as weight_kg, sp.brand_id, b.name as brand
    from public.supplier_prices sp
    join public.brands b on b.id = sp.brand_id
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active
      and sp.buy_price is not null
      and sp.normalized_code = public.normalize_part_code(input_code)
      and (coalesce(input_brand, '') = '' or sp.brand_id in (select id from requested_brand))
      and not exists (select 1 from catalog_exact)
    order by
      case when sp.brand_id in (select id from requested_brand) then 0 else 1 end,
      sp.buy_price asc,
      sp.valid_from desc,
      sp.updated_at desc
    limit 1
  ),
  catalog_fuzzy as (
    select cp.id, cp.product_code, cp.normalized_code, cp.description, cp.oem_no,
      cp.hs_code, cp.origin, cp.weight_kg, cp.brand_id, b.name as brand
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    where cp.organization_id = public.current_profile_org_id()
      and not exists (select 1 from catalog_exact)
      and not exists (select 1 from supplier_exact)
      and (
        cp.normalized_code like '%' || public.normalize_part_code(input_code) || '%'
        or public.normalize_part_code(input_code) like '%' || cp.normalized_code || '%'
        or (nullif(cp.normalized_oem, '') is not null and cp.normalized_oem like '%' || public.normalize_part_code(input_code) || '%')
        or (nullif(cp.normalized_oem, '') is not null and public.normalize_part_code(input_code) like '%' || cp.normalized_oem || '%')
      )
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by case when cp.brand_id in (select id from requested_brand) then 0 else 1 end, b.name, cp.product_code
    limit 1
  ),
  product_match as (
    select * from catalog_exact
    union all select * from supplier_exact
    union all select * from catalog_fuzzy
    limit 1
  )
  select
    product_match.id is not null,
    product_match.id,
    coalesce(product_match.product_code, input_code),
    product_match.brand,
    product_match.description,
    product_match.oem_no,
    product_match.hs_code,
    product_match.origin,
    product_match.weight_kg,
    best.supplier_id,
    supplier.name,
    best.buy_price,
    best.valid_from,
    case
      when upper(coalesce(input_customer_type, 'A')) = 'B' then round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2)
      else round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2)
    end,
    nullif(trim(coalesce(best.notes, '')), ''),
    coalesce(conflicts.has_conflict, false),
    coalesce(conflicts.fields, array[]::text[])
  from product_match
  left join lateral (
    select sp.supplier_id, sp.buy_price, sp.valid_from, sp.notes
    from public.supplier_prices sp
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active
      and sp.brand_id = product_match.brand_id
      and sp.normalized_code = product_match.normalized_code
      and sp.buy_price is not null
    order by sp.buy_price asc, sp.valid_from desc, sp.updated_at desc
    limit 1
  ) best on true
  left join public.suppliers supplier on supplier.id = best.supplier_id
  left join lateral (
    select true as has_conflict, array_agg(distinct pac.field_name order by pac.field_name) as fields
    from public.product_attribute_conflicts pac
    where pac.organization_id = public.current_profile_org_id()
      and pac.product_id = product_match.id
      and pac.status = 'pending_review'
    having count(*) > 0
  ) conflicts on true
  union all
  select false, null::uuid, input_code, null::text, null::text, null::text, null::text,
    null::text, null::numeric, null::uuid, null::text, null::numeric, null::date,
    null::numeric, null::text, false, array[]::text[]
  where not exists (select 1 from product_match);
$$;

grant execute on function public.cloud_resolve_quote_line(text, text, text, numeric, numeric) to authenticated;

-- Rollback/compensation order:
-- 1. Redeploy the previous ZF writer so it no longer calls the guarded RPC.
-- 2. Restore cloud_resolve_quote_line from 20260513_06_cloud_quote_rpc.sql.
-- 3. Drop apply_catalog_product_enrichment_guarded(jsonb, text, text).
-- 4. Keep product_attribute_conflicts as audit evidence; it can be dropped later
--    only after the business owner approves removal of that evidence.
