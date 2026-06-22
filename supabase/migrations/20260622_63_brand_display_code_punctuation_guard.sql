create or replace function public.normalize_catalog_display_code_for_brand(input_value text, input_brand text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when public.normalize_catalog_brand_key(input_brand) in (
      'BOSCH',
      'SACHS',
      'LEMFORDER',
      'WABCO',
      'MAHLE',
      'KNORR',
      'KNORRBREMSE',
      'MANN',
      'MANNFILTER'
    ) then regexp_replace(upper(coalesce(input_value, '')), '\s+', '', 'g')
    when public.normalize_catalog_brand_key(input_brand) = 'ZF'
      then regexp_replace(upper(coalesce(input_value, '')), '[\s.]+', '', 'g')
    else regexp_replace(upper(coalesce(input_value, '')), '\s+', ' ', 'g')
  end;
$$;

create or replace function public.normalize_brand_display_code_lines(input_lines jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  item jsonb;
  next_item jsonb;
  result jsonb := '[]'::jsonb;
begin
  if input_lines is null or jsonb_typeof(input_lines) <> 'array' then
    return coalesce(input_lines, '[]'::jsonb);
  end if;

  for item in select value from jsonb_array_elements(input_lines)
  loop
    next_item := item;
    if public.normalize_catalog_brand_key(next_item->>'brand') in (
      'BOSCH',
      'SACHS',
      'LEMFORDER',
      'WABCO',
      'MAHLE',
      'KNORR',
      'KNORRBREMSE',
      'MANN',
      'MANNFILTER',
      'ZF'
    ) then
      if next_item ? 'product_code' then
        next_item := jsonb_set(next_item, '{product_code}', to_jsonb(public.normalize_catalog_display_code_for_brand(next_item->>'product_code', next_item->>'brand')), true);
      end if;
      if next_item ? 'old_code' then
        next_item := jsonb_set(next_item, '{old_code}', to_jsonb(public.normalize_catalog_display_code_for_brand(next_item->>'old_code', next_item->>'brand')), true);
      end if;
      if next_item ? 'requestedCode' then
        next_item := jsonb_set(next_item, '{requestedCode}', to_jsonb(public.normalize_catalog_display_code_for_brand(next_item->>'requestedCode', next_item->>'brand')), true);
      end if;
      if next_item ? 'resolvedCode' then
        next_item := jsonb_set(next_item, '{resolvedCode}', to_jsonb(public.normalize_catalog_display_code_for_brand(next_item->>'resolvedCode', next_item->>'brand')), true);
      end if;
    end if;
    result := result || jsonb_build_array(next_item);
  end loop;

  return result;
end;
$$;

do $$
declare
  normalized_code_generated text := 'NEVER';
begin
  select coalesce(c.is_generated, 'NEVER')
    into normalized_code_generated
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'catalog_products'
    and c.column_name = 'normalized_code'
  limit 1;

  if normalized_code_generated = 'ALWAYS' then
    update public.catalog_products cp
    set product_code = public.normalize_catalog_display_code_for_brand(cp.product_code, b.name),
        updated_at = now()
    from public.brands b
    where b.id = cp.brand_id
      and public.normalize_catalog_brand_key(b.name) in (
        'BOSCH',
        'SACHS',
        'LEMFORDER',
        'WABCO',
        'MAHLE',
        'KNORR',
        'KNORRBREMSE',
        'MANN',
        'MANNFILTER',
        'ZF'
      )
      and public.normalize_catalog_display_code_for_brand(cp.product_code, b.name) <> ''
      and cp.product_code is distinct from public.normalize_catalog_display_code_for_brand(cp.product_code, b.name);
  else
    update public.catalog_products cp
    set product_code = public.normalize_catalog_display_code_for_brand(cp.product_code, b.name),
        normalized_code = public.normalize_part_code(public.normalize_catalog_display_code_for_brand(cp.product_code, b.name)),
        updated_at = now()
    from public.brands b
    where b.id = cp.brand_id
      and public.normalize_catalog_brand_key(b.name) in (
        'BOSCH',
        'SACHS',
        'LEMFORDER',
        'WABCO',
        'MAHLE',
        'KNORR',
        'KNORRBREMSE',
        'MANN',
        'MANNFILTER',
        'ZF'
      )
      and public.normalize_catalog_display_code_for_brand(cp.product_code, b.name) <> ''
      and cp.product_code is distinct from public.normalize_catalog_display_code_for_brand(cp.product_code, b.name);
  end if;
end $$;

do $$
declare
  normalized_code_generated text := 'NEVER';
begin
  select coalesce(c.is_generated, 'NEVER')
    into normalized_code_generated
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = 'supplier_prices'
    and c.column_name = 'normalized_code'
  limit 1;

  if normalized_code_generated = 'ALWAYS' then
    update public.supplier_prices sp
    set product_code = public.normalize_catalog_display_code_for_brand(sp.product_code, b.name),
        updated_at = now()
    from public.brands b
    where b.id = sp.brand_id
      and public.normalize_catalog_brand_key(b.name) in (
        'BOSCH',
        'SACHS',
        'LEMFORDER',
        'WABCO',
        'MAHLE',
        'KNORR',
        'KNORRBREMSE',
        'MANN',
        'MANNFILTER',
        'ZF'
      )
      and public.normalize_catalog_display_code_for_brand(sp.product_code, b.name) <> ''
      and sp.product_code is distinct from public.normalize_catalog_display_code_for_brand(sp.product_code, b.name);
  else
    update public.supplier_prices sp
    set product_code = public.normalize_catalog_display_code_for_brand(sp.product_code, b.name),
        normalized_code = public.normalize_part_code(public.normalize_catalog_display_code_for_brand(sp.product_code, b.name)),
        updated_at = now()
    from public.brands b
    where b.id = sp.brand_id
      and public.normalize_catalog_brand_key(b.name) in (
        'BOSCH',
        'SACHS',
        'LEMFORDER',
        'WABCO',
        'MAHLE',
        'KNORR',
        'KNORRBREMSE',
        'MANN',
        'MANNFILTER',
        'ZF'
      )
      and public.normalize_catalog_display_code_for_brand(sp.product_code, b.name) <> ''
      and sp.product_code is distinct from public.normalize_catalog_display_code_for_brand(sp.product_code, b.name);
  end if;
end $$;

update public.item_code_references r
set old_code = public.normalize_catalog_display_code_for_brand(r.old_code, b.name),
    new_code = public.normalize_catalog_display_code_for_brand(r.new_code, b.name),
    updated_at = now()
from public.brands b
where b.id = r.brand_id
  and public.normalize_catalog_brand_key(b.name) in (
    'BOSCH',
    'SACHS',
    'LEMFORDER',
    'WABCO',
    'MAHLE',
    'KNORR',
    'KNORRBREMSE',
    'MANN',
    'MANNFILTER',
    'ZF'
  )
  and (
    r.old_code is distinct from public.normalize_catalog_display_code_for_brand(r.old_code, b.name)
    or r.new_code is distinct from public.normalize_catalog_display_code_for_brand(r.new_code, b.name)
  );

update public.sales_orders
set lines = public.normalize_brand_display_code_lines(lines),
    updated_at = now()
where jsonb_typeof(lines) = 'array'
  and lines is distinct from public.normalize_brand_display_code_lines(lines);

update public.purchase_orders
set lines = public.normalize_brand_display_code_lines(lines),
    updated_at = now()
where jsonb_typeof(lines) = 'array'
  and lines is distinct from public.normalize_brand_display_code_lines(lines);

update public.invoices
set lines = public.normalize_brand_display_code_lines(lines),
    updated_at = now()
where jsonb_typeof(lines) = 'array'
  and lines is distinct from public.normalize_brand_display_code_lines(lines);

update public.bills
set lines = public.normalize_brand_display_code_lines(lines),
    updated_at = now()
where jsonb_typeof(lines) = 'array'
  and lines is distinct from public.normalize_brand_display_code_lines(lines);
