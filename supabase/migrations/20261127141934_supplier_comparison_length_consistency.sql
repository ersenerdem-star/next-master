-- Keep the single-offer details and batch note/catalog readers aligned.
-- Modify the live definition in place so concurrent unrelated fixes survive.
do $migration$
declare definition text; old_clause text := 'length(input_product_code)>100';
begin
  definition := pg_catalog.pg_get_functiondef('public.report_supplier_comparison_offers(uuid,text)'::pg_catalog.regprocedure);
  if (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause) <> 1 then
    raise exception 'SUPPLIER_OFFER_LENGTH_GUARD_CHANGED';
  end if;
  execute replace(definition,old_clause,'length(input_product_code)>256');
end;
$migration$;
notify pgrst, 'reload schema';
