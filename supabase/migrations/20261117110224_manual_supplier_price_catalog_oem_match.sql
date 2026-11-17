-- Preserve the normal free-form OEM bound, while accepting unchanged OEM data
-- that the manual-price form copied from this exact catalog product.
-- The baseline guard prevents replacing a concurrently changed writer. Keeping
-- the existing CREATE OR REPLACE definition also preserves its owner and ACL.
do $migration$
declare
  writer regprocedure := pg_catalog.to_regprocedure(
    'public.save_manual_supplier_price(uuid,uuid,text,numeric,date,text,text,integer,integer,integer,text)'
  );
  definition text;
  old_validation constant text := $old$    or length(coalesce(input_description,''))>1000 or length(coalesce(input_oem_no,''))>1000$old$;
  new_validation constant text := $new$    or length(coalesce(input_description,''))>1000
    or (length(coalesce(input_oem_no,''))>1000 and not exists (
      select 1 from public.catalog_products cp
      where cp.organization_id=org and cp.brand_id=input_brand_id
        and public.normalize_catalog_product_code(cp.product_code)=exact
        and pg_catalog.btrim(coalesce(cp.oem_no,''))=coalesce(input_oem_no,'')
    ))$new$;
begin
  if writer is null then
    raise exception 'MANUAL_SUPPLIER_PRICE_WRITER_MISSING';
  end if;
  definition := pg_catalog.pg_get_functiondef(writer);
  if pg_catalog.md5(definition) is distinct from 'e8c17d6fc0f50d4d10613ebabd59b917' then
    raise exception 'MANUAL_SUPPLIER_PRICE_WRITER_BASELINE_CHANGED';
  end if;
  if pg_catalog.length(definition)-pg_catalog.length(pg_catalog.replace(definition,old_validation,''))
    <>pg_catalog.length(old_validation) then
    raise exception 'MANUAL_SUPPLIER_PRICE_OEM_VALIDATION_NOT_UNIQUE';
  end if;
  execute pg_catalog.replace(definition,old_validation,new_validation);
end;
$migration$;
