-- A new manual sales line reads current commercial prices through V3. Its
-- product details must come from the live catalog, as CSV import and explicit
-- catalog sync already do. Existing document snapshots are never rewritten.
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Patch only the reviewed deployed reader. Its signature, authorization,
-- security configuration, grants, price selection and price math are retained.
do $migration$
declare
  definition text;
  anchor text;
  replacement text;
begin
  definition := pg_get_functiondef(
    'public.cloud_resolve_quote_line_v3(text,text,text,numeric,numeric)'::regprocedure
  );
  if md5(definition) <> 'e13b82634667de5ba04f1f70ba47d787' then
    raise exception 'QUOTE_RESOLVER_CATALOG_BASELINE_CHANGED';
  end if;

  anchor := '  v_margin numeric;';
  replacement := anchor || E'\n  v_catalog public.catalog_products%rowtype;\n  v_exact_code text;\n  v_is_sachs boolean;\n  v_catalog_description text;';
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'QUOTE_RESOLVER_CATALOG_DECLARATION_ANCHOR_CHANGED';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := '  v_margin := case when upper(coalesce(input_customer_type,''A''))=''B''';
  replacement := $catalog$
  -- A compact search key bounds the indexed lookup, but does not establish
  -- SKU identity: 61/1 must never borrow metadata from 611, or lose zeros.
  v_exact_code := pg_catalog.upper(pg_catalog.regexp_replace(
    pg_catalog.btrim(v_best.product_code), '[[:space:]]+', '', 'g'));
  v_is_sachs := public.normalize_part_code(v_best.brand) = 'SACHS';
  if v_is_sachs and v_exact_code ~ '^[0-9]{3}\.[0-9]{3}$' then
    v_exact_code := pg_catalog.replace(v_exact_code, '.', '');
  end if;

  select cp.* into v_catalog
  from public.catalog_products cp
  cross join lateral (
    select pg_catalog.upper(pg_catalog.regexp_replace(
      pg_catalog.btrim(cp.product_code), '[[:space:]]+', '', 'g')) as exact_code
  ) catalog_sku
  where cp.organization_id = public.current_profile_org_id()
    and cp.brand_id = v_best.brand_id
    and cp.normalized_code = public.normalize_part_code(v_best.product_code)
    and (case
      -- Only the approved six-digit SACHS 3+3 display separator is an alias.
      when v_is_sachs and catalog_sku.exact_code ~ '^[0-9]{3}\.[0-9]{3}$'
        then pg_catalog.replace(catalog_sku.exact_code, '.', '')
      else catalog_sku.exact_code
    end) = v_exact_code;

  v_catalog_description := nullif(pg_catalog.regexp_replace(
    coalesce(v_catalog.description, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g'), '');
  if v_catalog_description = '-'
    or public.normalize_part_code(v_catalog_description) = public.normalize_part_code(v_catalog.product_code) then
    -- A code-only catalog placeholder must not replace a useful supplier name.
    v_catalog_description := null;
  end if;

$catalog$ || anchor;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'QUOTE_RESOLVER_CATALOG_LOOKUP_ANCHOR_CHANGED';
  end if;
  definition := replace(definition, anchor, replacement);

  anchor := E'  return query select true,null::uuid,v_best.product_code,v_best.brand,\n    v_best.description,null::text,null::text,null::text,null::numeric,';
  replacement := E'  return query select true,v_catalog.id,v_best.product_code,v_best.brand,\n    coalesce(v_catalog_description,v_best.description),v_catalog.oem_no,v_catalog.hs_code,v_catalog.origin,v_catalog.weight_kg,';
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'QUOTE_RESOLVER_CATALOG_PROJECTION_ANCHOR_CHANGED';
  end if;
  definition := replace(definition, anchor, replacement);

  execute definition;
end;
$migration$;
