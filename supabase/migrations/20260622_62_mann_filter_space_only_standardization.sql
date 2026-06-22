create or replace function public.normalize_catalog_display_code_for_brand(input_value text, input_brand text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when public.normalize_catalog_brand_key(input_brand) in ('MANN', 'MANNFILTER')
      then regexp_replace(upper(coalesce(input_value, '')), '\s+', '', 'g')
    when public.normalize_catalog_brand_key(input_brand) in (
      'BOSCH',
      'SACHS',
      'LEMFORDER',
      'WABCO',
      'ZF',
      'MAHLE',
      'KNORR',
      'KNORRBREMSE'
    ) then regexp_replace(upper(coalesce(input_value, '')), '[^A-Z0-9]+', '', 'g')
    else regexp_replace(upper(coalesce(input_value, '')), '\s+', ' ', 'g')
  end;
$$;
