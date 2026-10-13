-- A published V3 brand is sourced from immutable release rows. A successful
-- legacy supplier_prices write would otherwise be invisible to export and
-- partly invisible to quote/order reads. Reject the old writer at admission
-- and at the table, including direct Data API calls and queued finalizers.

create index if not exists idx_supplier_current_price_pointers_org_brand
  on public.supplier_current_price_pointers (organization_id, brand_id);

create or replace function public.assert_legacy_supplier_price_write_allowed(input_brand text)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_organization_id uuid := public.current_profile_org_id();
  v_brand_name text := coalesce(nullif(pg_catalog.btrim(input_brand), ''), 'Unbranded');
begin
  if v_organization_id is null
     or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  if exists (
    select 1
    from public.brands b
    join public.supplier_current_price_pointers ptr
      on ptr.organization_id = b.organization_id and ptr.brand_id = b.id
    where b.organization_id = v_organization_id
      and b.normalized_name = public.normalize_part_code(v_brand_name)
  ) then
    raise exception 'LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED';
  end if;

  return true;
end;
$function$;

revoke all on function public.assert_legacy_supplier_price_write_allowed(text)
  from public, anon;
grant execute on function public.assert_legacy_supplier_price_write_allowed(text)
  to authenticated;

-- Preserve the stale-run cleanup in the current begin wrapper.
create or replace function public.begin_supplier_price_import(
  input_supplier_name text,
  input_brand text,
  input_mode text default 'replace'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
begin
  perform public.assert_legacy_supplier_price_write_allowed(input_brand);
  perform public.close_stale_supplier_price_import_runs(interval '2 hours');
  return public.begin_supplier_price_import_inner(input_supplier_name, input_brand, input_mode);
end;
$function$;

-- Preserve order_multiple propagation in the current direct-import wrapper.
create or replace function public.bulk_import_supplier_prices(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  result jsonb;
  org_id uuid := public.current_profile_org_id();
  v_brand_name text;
begin
  if org_id is null
     or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  for v_brand_name in
    select distinct coalesce(nullif(pg_catalog.btrim(rows.brand), ''), 'Unbranded')
    from pg_catalog.jsonb_to_recordset(payload) as rows(brand text)
  loop
    perform public.assert_legacy_supplier_price_write_allowed(v_brand_name);
  end loop;

  result := public.bulk_import_supplier_prices_inner(payload);

  update public.supplier_prices price
  set order_multiple = nullif(rows.order_multiple, 0)
  from (
    select distinct on (
      public.normalize_part_code(supplier_name),
      public.normalize_part_code(coalesce(brand, 'Unbranded')),
      public.normalize_part_code(product_code),
      coalesce(valid_from, current_date)
    ) supplier_name, brand, product_code, valid_from, order_multiple
    from pg_catalog.jsonb_to_recordset(payload) as input_rows(
      supplier_name text,
      brand text,
      product_code text,
      valid_from date,
      order_multiple integer
    )
    where order_multiple is not null
    order by
      public.normalize_part_code(supplier_name),
      public.normalize_part_code(coalesce(brand, 'Unbranded')),
      public.normalize_part_code(product_code),
      coalesce(valid_from, current_date),
      order_multiple desc nulls last
  ) rows
  join public.suppliers supplier
    on supplier.organization_id = org_id
   and supplier.normalized_name = public.normalize_part_code(rows.supplier_name)
  join public.brands brand
    on brand.organization_id = org_id
   and brand.normalized_name = public.normalize_part_code(coalesce(rows.brand, 'Unbranded'))
  where price.organization_id = org_id
    and price.supplier_id = supplier.id
    and price.brand_id = brand.id
    and price.normalized_code = public.normalize_part_code(rows.product_code)
    and price.valid_from = coalesce(rows.valid_from, current_date)
    and rows.order_multiple is not null;

  return result;
end;
$function$;

-- Retention deletes and non-price catalog enrichment remain available. V3
-- release/publication tables are separate and never reach this trigger.
create or replace function public.reject_legacy_supplier_price_published_write()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if exists (
    select 1
    from public.supplier_current_price_pointers ptr
    where ptr.organization_id = new.organization_id
      and ptr.brand_id = new.brand_id
  ) or (
    tg_op = 'UPDATE'
    and (old.organization_id is distinct from new.organization_id
      or old.brand_id is distinct from new.brand_id)
    and exists (
      select 1
      from public.supplier_current_price_pointers ptr
      where ptr.organization_id = old.organization_id
        and ptr.brand_id = old.brand_id
    )
  ) then
    raise exception 'LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED';
  end if;
  return new;
end;
$function$;

revoke all on function public.reject_legacy_supplier_price_published_write()
  from public, anon, authenticated;

drop trigger if exists supplier_prices_reject_published_legacy_write on public.supplier_prices;
create trigger supplier_prices_reject_published_legacy_write
before insert or update of organization_id, supplier_id, brand_id,
  product_code, normalized_code, buy_price, currency, valid_from, valid_to,
  is_active, moq, order_multiple, lead_time_days
on public.supplier_prices
for each row execute function public.reject_legacy_supplier_price_published_write();
