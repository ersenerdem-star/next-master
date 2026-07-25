-- NM-CATALOG-PRODUCT-RELATION-CONTRACT
-- Reusable, source-backed relation capture for replacement, supersession,
-- alternative and other supported catalog product relations.
--
-- This migration does not assert a relation for any product. It creates an
-- append-only evidence boundary only. Operational item_code_references and
-- canonical catalog_products are intentionally not mutated by this contract.

create or replace function public.normalize_catalog_relation_code(input text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select regexp_replace(btrim(coalesce(input, '')), '\s+', '', 'g');
$$;

comment on function public.normalize_catalog_relation_code(text) is
  'Relation-code identity normalizer: removes whitespace only, preserves punctuation such as hyphen, slash and dot.';

alter table public.catalog_product_relations
  add column if not exists normalized_related_product_code text
    generated always as (public.normalize_catalog_relation_code(related_product_code)) stored,
  add column if not exists normalized_related_oem_no text
    generated always as (public.normalize_catalog_relation_code(related_oem_no)) stored;

alter table public.catalog_product_relations
  drop constraint if exists catalog_product_relations_target_check;

alter table public.catalog_product_relations
  add constraint catalog_product_relations_target_check
  check (
    nullif(btrim(coalesce(related_product_code, '')), '') is not null
    or nullif(btrim(coalesce(related_oem_no, '')), '') is not null
  ) not valid;

alter table public.catalog_product_relations
  validate constraint catalog_product_relations_target_check;

create index if not exists idx_catalog_product_relations_related_code
  on public.catalog_product_relations (
    organization_id,
    lower(coalesce(related_brand, '')),
    lower(normalized_related_product_code)
  )
  where normalized_related_product_code <> '';

comment on column public.catalog_product_relations.normalized_related_product_code is
  'Whitespace-only normalized lookup form. Raw related_product_code remains the display and provenance value.';

comment on column public.catalog_product_relations.normalized_related_oem_no is
  'Whitespace-only normalized lookup form. Raw related_oem_no remains the display and provenance value.';

comment on table public.catalog_product_relations is
  'Append-only, source-backed product relation evidence. replacement means the current product replaces the related code; replaced_by means the current product is superseded by the related code. No row automatically mutates item_code_references or catalog_products.';

revoke insert on table public.catalog_product_relations from authenticated;

drop policy if exists catalog_product_relations_insert_admin
  on public.catalog_product_relations;

create or replace function public.record_catalog_product_relation(
  input_catalog_product_id uuid,
  input_source_record_id uuid,
  input_relation_type text,
  input_related_brand text,
  input_related_product_code text,
  input_related_oem_no text default null,
  input_related_description text default null
)
returns public.catalog_product_relations
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_product public.catalog_products%rowtype;
  v_current_brand text;
  v_relation_type text := lower(btrim(coalesce(input_relation_type, '')));
  v_related_brand text := nullif(btrim(coalesce(input_related_brand, '')), '');
  v_related_product_code text := nullif(btrim(coalesce(input_related_product_code, '')), '');
  v_related_oem_no text := nullif(btrim(coalesce(input_related_oem_no, '')), '');
  v_related_description text := nullif(btrim(coalesce(input_related_description, '')), '');
  v_relation_fingerprint text;
  v_relation public.catalog_product_relations%rowtype;
begin
  if input_catalog_product_id is null then
    raise exception using errcode = '22023', message = 'catalog_product_id is required';
  end if;

  if input_source_record_id is null then
    raise exception using errcode = '22023', message = 'source_record_id is required';
  end if;

  if v_relation_type not in (
    'replacement',
    'replaced_by',
    'alternative',
    'kit_component',
    'recommended_tool',
    'related'
  ) then
    raise exception using errcode = '22023', message = 'Unsupported catalog relation type';
  end if;

  if v_related_product_code is null and v_related_oem_no is null then
    raise exception using errcode = '22023', message = 'related product code or OEM number is required';
  end if;

  select p.*
    into v_product
  from public.catalog_products p
  where p.id = input_catalog_product_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Catalog product not found';
  end if;

  perform 1
  from public.catalog_product_source_records s
  where s.id = input_source_record_id
    and s.organization_id = v_product.organization_id
    and s.catalog_product_id = v_product.id;

  if not found then
    raise exception using errcode = '23503', message = 'Source record does not belong to the catalog product tenant boundary';
  end if;

  select b.name
    into v_current_brand
  from public.brands b
  where b.id = v_product.brand_id;

  if v_relation_type in ('replacement', 'replaced_by', 'alternative')
    and v_related_product_code is not null
    and lower(coalesce(v_related_brand, v_current_brand, '')) = lower(coalesce(v_current_brand, ''))
    and lower(public.normalize_catalog_relation_code(v_related_product_code))
      = lower(public.normalize_catalog_relation_code(v_product.product_code))
  then
    raise exception using errcode = '23514', message = 'A product cannot relate to itself under the same brand';
  end if;

  v_relation_fingerprint := encode(
    digest(
      jsonb_build_object(
        'organizationId', v_product.organization_id,
        'catalogProductId', v_product.id,
        'sourceRecordId', input_source_record_id,
        'relationType', v_relation_type,
        'relatedBrand', lower(coalesce(v_related_brand, '')),
        'relatedProductCode', public.normalize_catalog_relation_code(v_related_product_code),
        'relatedOemNo', public.normalize_catalog_relation_code(v_related_oem_no),
        'relatedDescription', coalesce(v_related_description, '')
      )::text,
      'sha256'
    ),
    'hex'
  );

  insert into public.catalog_product_relations (
    organization_id,
    catalog_product_id,
    relation_type,
    related_brand,
    related_product_code,
    related_oem_no,
    related_description,
    source_record_id,
    relation_fingerprint
  )
  values (
    v_product.organization_id,
    v_product.id,
    v_relation_type,
    v_related_brand,
    v_related_product_code,
    v_related_oem_no,
    v_related_description,
    input_source_record_id,
    v_relation_fingerprint
  )
  on conflict (organization_id, catalog_product_id, relation_fingerprint)
  do nothing
  returning * into v_relation;

  if v_relation.id is null then
    select r.*
      into v_relation
    from public.catalog_product_relations r
    where r.organization_id = v_product.organization_id
      and r.catalog_product_id = v_product.id
      and r.relation_fingerprint = v_relation_fingerprint;
  end if;

  return v_relation;
end;
$$;

revoke all on function public.record_catalog_product_relation(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.record_catalog_product_relation(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text
) to service_role;

comment on function public.record_catalog_product_relation(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text
) is
  'Service-owned, idempotent append-only relation evidence writer. Requires a source record bound to the same product and organization; does not create operational replacement mappings.';
