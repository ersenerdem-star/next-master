-- Save quote header and lines to Supabase.
-- Run this in Supabase SQL Editor.

alter table quote_lines add column if not exists brand_text text;
alter table quote_lines add column if not exists supplier_name text;
alter table quote_lines add column if not exists price_date date;
alter table quotes add column if not exists revision_no integer not null default 0;
alter table quotes add column if not exists parent_quote_id uuid references quotes(id) on delete set null;

create or replace function save_cloud_quote(
  input_quote jsonb,
  input_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  profile_id uuid;
  saved_quote_id uuid;
  saved_quote_no text;
  line_count integer := 0;
begin
  org_id := current_profile_org_id();
  profile_id := auth.uid();

  if org_id is null or current_profile_role() not in ('admin', 'sales') then
    raise exception 'Only active admin or sales users can save quotes';
  end if;

  saved_quote_no := nullif(trim(coalesce(input_quote->>'quote_no', '')), '');
  if saved_quote_no is null then
    saved_quote_no := 'Q-' || to_char(now(), 'YYYYMMDD-HH24MISS');
  end if;

  insert into quotes (
    organization_id,
    created_by,
    quote_no,
    quote_date,
    currency,
    customer_name,
    seller_info,
    buyer_info,
    delivery_term,
    payment_terms,
    packing_details,
    notes,
    shipping_cost,
    status
  )
  values (
    org_id,
    profile_id,
    saved_quote_no,
    coalesce(nullif(input_quote->>'quote_date', '')::date, current_date),
    coalesce(nullif(input_quote->>'currency', ''), 'EUR'),
    nullif(input_quote->>'customer_name', ''),
    nullif(input_quote->>'seller_info', ''),
    nullif(input_quote->>'buyer_info', ''),
    nullif(input_quote->>'delivery_term', ''),
    nullif(input_quote->>'payment_terms', ''),
    nullif(input_quote->>'packing_details', ''),
    nullif(input_quote->>'notes', ''),
    coalesce(nullif(input_quote->>'shipping_cost', '')::numeric, 0),
    coalesce(nullif(input_quote->>'status', ''), 'draft')
  )
  on conflict (organization_id, quote_no) do update set
    quote_date = excluded.quote_date,
    currency = excluded.currency,
    customer_name = excluded.customer_name,
    seller_info = excluded.seller_info,
    buyer_info = excluded.buyer_info,
    delivery_term = excluded.delivery_term,
    payment_terms = excluded.payment_terms,
    packing_details = excluded.packing_details,
    notes = excluded.notes,
    shipping_cost = excluded.shipping_cost,
    status = excluded.status,
    updated_at = now()
  returning id into saved_quote_id;

  with parsed_lines as (
    select
      saved_quote_id as quote_id,
      coalesce(nullif(line->>'line_no', '')::integer, row_number() over ()) as line_no,
      coalesce(nullif(line->>'product_code', ''), 'UNKNOWN') as product_code,
      nullif(line->>'brand', '') as brand_text,
      nullif(line->>'description', '') as description,
      nullif(line->>'hs_code', '') as hs_code,
      coalesce(nullif(line->>'qty', '')::integer, 1) as qty,
      nullif(line->>'weight_kg', '')::numeric as weight_kg,
      nullif(line->>'origin', '') as origin,
      nullif(line->>'supplier_name', '') as supplier_name,
      nullif(line->>'price_date', '')::date as price_date,
      nullif(line->>'buy_unit_price', '')::numeric as buy_unit_price,
      nullif(line->>'sell_unit_price', '')::numeric as sell_unit_price,
      case
        when coalesce((line->>'found')::boolean, true) then 'ok'
        else 'not_in_system'
      end as status
    from jsonb_array_elements(input_lines) as line
  ),
  catalog_match as (
    select distinct on (pl.line_no)
      pl.line_no,
      cp.id as catalog_product_id,
      cp.brand_id,
      cp.description as catalog_description,
      cp.hs_code as catalog_hs_code,
      cp.origin as catalog_origin,
      cp.weight_kg as catalog_weight_kg
    from parsed_lines pl
    join quotes q
      on q.id = pl.quote_id
    left join brands b
      on b.organization_id = q.organization_id
     and b.normalized_name = normalize_part_code(coalesce(pl.brand_text, ''))
    join catalog_products cp
      on cp.organization_id = q.organization_id
     and cp.normalized_code = normalize_part_code(pl.product_code)
     and (
       b.id is null
       or cp.brand_id = b.id
     )
    order by
      pl.line_no,
      case when b.id is not null and cp.brand_id = b.id then 0 else 1 end,
      cp.updated_at desc,
      cp.created_at desc
  ),
  prepared_lines as (
    select
      pl.quote_id,
      pl.line_no,
      pl.product_code,
      pl.brand_text,
      coalesce(pl.description, cm.catalog_description) as description,
      coalesce(pl.hs_code, cm.catalog_hs_code) as hs_code,
      pl.qty,
      coalesce(pl.weight_kg, cm.catalog_weight_kg) as weight_kg,
      coalesce(pl.origin, cm.catalog_origin) as origin,
      pl.supplier_name,
      pl.price_date,
      pl.buy_unit_price,
      pl.sell_unit_price,
      pl.status,
      cm.brand_id,
      cm.catalog_product_id
    from parsed_lines pl
    left join catalog_match cm
      on cm.line_no = pl.line_no
  ),
  deleted as (
    delete from quote_lines ql
    where ql.quote_id = saved_quote_id
      and not exists (
        select 1
        from prepared_lines pl
        where pl.quote_id = ql.quote_id
          and pl.line_no = ql.line_no
      )
    returning ql.id
  ),
  upserted as (
    insert into quote_lines (
      quote_id,
      line_no,
      brand_id,
      catalog_product_id,
      product_code,
      brand_text,
      description,
      hs_code,
      qty,
      weight_kg,
      origin,
      supplier_name,
      price_date,
      buy_unit_price,
      sell_unit_price,
      status
    )
    select
      quote_id,
      line_no,
      brand_id,
      catalog_product_id,
      product_code,
      brand_text,
      description,
      hs_code,
      qty,
      weight_kg,
      origin,
      supplier_name,
      price_date,
      buy_unit_price,
      sell_unit_price,
      status
    from prepared_lines
    on conflict (quote_id, line_no) do update set
      brand_id = excluded.brand_id,
      catalog_product_id = excluded.catalog_product_id,
      product_code = excluded.product_code,
      brand_text = excluded.brand_text,
      description = excluded.description,
      hs_code = excluded.hs_code,
      qty = excluded.qty,
      weight_kg = excluded.weight_kg,
      origin = excluded.origin,
      supplier_name = excluded.supplier_name,
      price_date = excluded.price_date,
      buy_unit_price = excluded.buy_unit_price,
      sell_unit_price = excluded.sell_unit_price,
      status = excluded.status,
      updated_at = now()
    where
      quote_lines.brand_id is distinct from excluded.brand_id
      or quote_lines.catalog_product_id is distinct from excluded.catalog_product_id
      or
      quote_lines.product_code is distinct from excluded.product_code
      or quote_lines.brand_text is distinct from excluded.brand_text
      or quote_lines.description is distinct from excluded.description
      or quote_lines.hs_code is distinct from excluded.hs_code
      or quote_lines.qty is distinct from excluded.qty
      or quote_lines.weight_kg is distinct from excluded.weight_kg
      or quote_lines.origin is distinct from excluded.origin
      or quote_lines.supplier_name is distinct from excluded.supplier_name
      or quote_lines.price_date is distinct from excluded.price_date
      or quote_lines.buy_unit_price is distinct from excluded.buy_unit_price
      or quote_lines.sell_unit_price is distinct from excluded.sell_unit_price
      or quote_lines.status is distinct from excluded.status
    returning 1
  )
  select count(*) into line_count
  from prepared_lines;

  return jsonb_build_object(
    'status', 'ok',
    'quote_id', saved_quote_id,
    'quote_no', saved_quote_no,
    'line_count', line_count
  );
end;
$$;

grant execute on function save_cloud_quote(jsonb, jsonb) to authenticated;
