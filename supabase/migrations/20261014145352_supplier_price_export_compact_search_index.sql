-- OEM lists can exceed a B-tree tuple even after TOAST compression. Preserve
-- complete OEM data and its existing hash/trigram indexes. This index serves
-- scoped normalized-code equality/prefix searches; export ordering has its own
-- product-code C-collation keyset index.
-- Production: prebuild this exact definition concurrently, then place this
-- migration BEFORE 20261014072055 in the explicit promotion manifest. The
-- historical wide IF NOT EXISTS then skips this name without being rewritten.
-- An existing wide/invalid index requires separately reviewed operator repair.
-- This migration never drops/replaces an index or changes business rows.
create index if not exists idx_supplier_prices_export_search
  on public.supplier_prices (
    organization_id,
    supplier_id,
    brand_id,
    normalized_code text_pattern_ops
  )
  where is_active;

do $compact_search_guard$
declare
  v_path text := current_setting('search_path');
  v_definition text;
  v_usable boolean;
begin
  perform set_config('search_path','pg_catalog',true);
  select pg_get_indexdef(c.oid),
    c.relkind='i' and i.indisvalid and i.indisready and i.indislive and not i.indisunique
    into v_definition,v_usable
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    left join pg_index i on i.indexrelid=c.oid
   where n.nspname='public' and c.relname='idx_supplier_prices_export_search';
  if v_usable is distinct from true or v_definition is distinct from
    'CREATE INDEX idx_supplier_prices_export_search ON public.supplier_prices USING btree (organization_id, supplier_id, brand_id, normalized_code text_pattern_ops) WHERE is_active'
  then raise exception 'SUPPLIER_EXPORT_COMPACT_SEARCH_INDEX_REVIEW_REQUIRED'; end if;
  perform set_config('search_path',v_path,true);
end;
$compact_search_guard$;
