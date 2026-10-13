-- Invoice and purchase-order repricing also need current legacy-scope prices.
-- Keep the published-scope bit so quote imports continue to choose the
-- established legacy path while repricing can use exact current options.

create or replace function public.cloud_current_supplier_price_options_batch(
  input_requests jsonb
)
returns table (
  request_index integer,
  has_published_scope boolean,
  options jsonb
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'SUPPLIER_PRICE_AUTH_REQUIRED';
  end if;
  v_organization_id := public.current_profile_org_id();
  if v_organization_id is null then
    raise exception 'SUPPLIER_PRICE_ORGANIZATION_REQUIRED';
  end if;
  if pg_catalog.jsonb_typeof(input_requests) is distinct from 'array' then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if pg_catalog.jsonb_array_length(input_requests) not between 1 and 25 then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(input_requests) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value->'code') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value->'brand') is distinct from 'string'
      or pg_catalog.length(pg_catalog.btrim(item.value->>'code')) not between 1 and 100
      or pg_catalog.length(pg_catalog.btrim(item.value->>'brand')) not between 1 and 100
  ) then
    raise exception 'SUPPLIER_PRICE_BATCH_INPUT_INVALID';
  end if;

  return query
  with requested as materialized (
    select (item.ordinality - 1)::integer as row_index,
      pg_catalog.btrim(item.value->>'code') as code,
      pg_catalog.btrim(item.value->>'brand') as brand
    from pg_catalog.jsonb_array_elements(input_requests) with ordinality as item(value, ordinality)
  ), scoped as materialized (
    select r.*,
      exists (
        select 1
        from public.brands b
        join public.supplier_current_price_pointers ptr
          on ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        join public.supplier_price_publications pub
          on pub.id=ptr.publication_id and pub.release_id=ptr.release_id
          and pub.organization_id=ptr.organization_id
          and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id
          and pub.status='published'
        where b.organization_id=v_organization_id
          and b.normalized_name=public.normalize_part_code(r.brand)
      ) as published_scope
    from requested r
  )
  select s.row_index, s.published_scope,
    coalesce(p.options, '[]'::jsonb) as options
  from scoped s
  left join lateral (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o)
      order by o.buy_price, o.price_date desc, o.supplier_id) as options
    from public.cloud_current_supplier_price_options(
      s.code,s.brand) o
  ) p on true
  order by s.row_index;
end;
$function$;

revoke all on function public.cloud_current_supplier_price_options_batch(jsonb)
  from public, anon;
grant execute on function public.cloud_current_supplier_price_options_batch(jsonb)
  to authenticated;
