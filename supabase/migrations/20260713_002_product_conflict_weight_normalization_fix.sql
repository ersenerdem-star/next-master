-- RAP-A2 forward fix: normalize weight conflicts by numeric value, not text scale.

create or replace function public.normalize_product_conflict_value(
  input_field_name text,
  input_value text
)
returns text
language sql
immutable
set search_path = public
as $$
  with normalized_input as (
    select
      lower(trim(coalesce(input_field_name, ''))) as field_name,
      trim(coalesce(input_value, '')) as raw_value
  ),
  parsed_weight as (
    select
      field_name,
      raw_value,
      case
        when raw_value ~ '^[+-]?[0-9]+([.][0-9]+)?$'
          then raw_value::numeric
        else null::numeric
      end as numeric_value
    from normalized_input
  )
  select case field_name
    when 'ean' then regexp_replace(coalesce(input_value, ''), '[^0-9]', '', 'g')
    when 'hs_code' then upper(regexp_replace(trim(coalesce(input_value, '')), '[^[:alnum:]]', '', 'g'))
    when 'origin' then upper(regexp_replace(trim(coalesce(input_value, '')), '\s+', ' ', 'g'))
    when 'weight_kg' then case
      when numeric_value is null then raw_value
      when numeric_value = 0 then '0'
      else regexp_replace(
        regexp_replace(numeric_value::text, '(\.[0-9]*?)0+$', '\1'),
        '\.$',
        ''
      )
    end
    else lower(regexp_replace(trim(coalesce(input_value, '')), '\s+', ' ', 'g'))
  end
  from parsed_weight;
$$;
