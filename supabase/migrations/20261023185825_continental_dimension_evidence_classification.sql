-- Supported dimensional evidence must not also appear as unsupported history.
do $migration$
declare
  definition text;
  old_fragment text := E'where not c.has_provenance and not exists (\n      select 1 from matches m where m.brand_id=c.brand_id and m.code=c.code\n    )';
  new_fragment text := E'where not c.has_provenance and not exists (\n      select 1 from source_matches m where m.brand_id=c.brand_id and m.code=c.code\n    )';
begin
  definition := pg_get_functiondef('supplier_price_validation_internal.cross_brand_audit(uuid)'::regprocedure);
  if position(old_fragment in definition) = 0 then
    raise exception 'CONTINENTAL_DIMENSION_CLASSIFICATION_BASELINE_MISMATCH';
  end if;
  execute replace(definition, old_fragment, new_fragment);
end
$migration$;
