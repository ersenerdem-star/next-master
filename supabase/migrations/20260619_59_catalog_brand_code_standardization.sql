create extension if not exists unaccent;

create or replace function public.normalize_catalog_brand_key(input_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(upper(unaccent(coalesce(input_value, ''))), '[^A-Z0-9]+', '', 'g');
$$;

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
      'ZF',
      'MANN',
      'MANNFILTER',
      'MAHLE',
      'KNORRBREMSE'
    ) then regexp_replace(upper(coalesce(input_value, '')), '[^A-Z0-9]+', '', 'g')
    else regexp_replace(upper(coalesce(input_value, '')), '\s+', ' ', 'g')
  end;
$$;

update public.brands
set name = 'Wabco',
    updated_at = now()
where public.normalize_catalog_brand_key(name) = 'WABCO'
  and name is distinct from 'Wabco';

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
    execute $sql$
      with candidates as (
        select
          cp.id,
          cp.organization_id,
          cp.brand_id,
          public.normalize_catalog_display_code_for_brand(cp.product_code, b.name) as next_code,
          count(*) over (
            partition by cp.organization_id,
            cp.brand_id,
            public.normalize_catalog_display_code_for_brand(cp.product_code, b.name)
          ) as target_count
        from public.catalog_products cp
        join public.brands b on b.id = cp.brand_id
        where public.normalize_catalog_brand_key(b.name) in (
          'BOSCH',
          'SACHS',
          'LEMFORDER',
          'WABCO',
          'ZF',
          'MANN',
          'MANNFILTER',
          'MAHLE',
          'KNORRBREMSE'
        )
      )
      update public.catalog_products cp
      set product_code = candidates.next_code,
          updated_at = now()
      from candidates
      where cp.id = candidates.id
        and candidates.next_code <> ''
        and candidates.target_count = 1
        and cp.product_code is distinct from candidates.next_code
        and not exists (
          select 1
          from public.catalog_products other
          where other.organization_id = cp.organization_id
            and other.brand_id = cp.brand_id
            and other.id <> cp.id
            and other.normalized_code = public.normalize_part_code(candidates.next_code)
        );
    $sql$;
  else
    execute $sql$
      with candidates as (
        select
          cp.id,
          cp.organization_id,
          cp.brand_id,
          public.normalize_catalog_display_code_for_brand(cp.product_code, b.name) as next_code,
          count(*) over (
            partition by cp.organization_id,
            cp.brand_id,
            public.normalize_catalog_display_code_for_brand(cp.product_code, b.name)
          ) as target_count
        from public.catalog_products cp
        join public.brands b on b.id = cp.brand_id
        where public.normalize_catalog_brand_key(b.name) in (
          'BOSCH',
          'SACHS',
          'LEMFORDER',
          'WABCO',
          'ZF',
          'MANN',
          'MANNFILTER',
          'MAHLE',
          'KNORRBREMSE'
        )
      )
      update public.catalog_products cp
      set product_code = candidates.next_code,
          normalized_code = public.normalize_part_code(candidates.next_code),
          updated_at = now()
      from candidates
      where cp.id = candidates.id
        and candidates.next_code <> ''
        and candidates.target_count = 1
        and cp.product_code is distinct from candidates.next_code
        and not exists (
          select 1
          from public.catalog_products other
          where other.organization_id = cp.organization_id
            and other.brand_id = cp.brand_id
            and other.id <> cp.id
            and other.normalized_code = public.normalize_part_code(candidates.next_code)
        );
    $sql$;
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
    'ZF',
    'MANN',
    'MANNFILTER',
    'MAHLE',
    'KNORRBREMSE'
  )
  and (
    r.old_code is distinct from public.normalize_catalog_display_code_for_brand(r.old_code, b.name)
    or r.new_code is distinct from public.normalize_catalog_display_code_for_brand(r.new_code, b.name)
  );
