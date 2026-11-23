-- Keep long conflict evidence intact while bounding the B-tree deduplication key.
set local lock_timeout = '2s';
lock table public.product_attribute_conflicts in share row exclusive mode;

create function public.product_conflict_index_key(normalized_value text)
returns text
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select case
    when octet_length(normalized_value) > 2000
      or left(normalized_value, 11) = '@nm-sha256@'
    then '@nm-sha256@' || encode(sha256(convert_to(normalized_value, 'UTF8')), 'hex')
    else normalized_value
  end;
$$;

update public.product_attribute_conflicts
set normalized_incoming_value = public.product_conflict_index_key(normalized_incoming_value)
where octet_length(normalized_incoming_value) > 2000
   or left(normalized_incoming_value, 11) = '@nm-sha256@';

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
  select public.product_conflict_index_key(case field_name
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
  end)
  from parsed_weight;
$$;
