-- Supplier price availability is controlled by price_usage_enabled, separately
-- from archival of the supplier card. Published and legacy readers already
-- use this contract; two manual-price branches had an extra is_active gate.
-- Patch only those clauses, preserving function bodies, owner and ACLs.
do $migration$
declare
  definition text;
  old_clause text;
  new_clause text;
begin
  definition := pg_catalog.pg_get_functiondef('public.cloud_current_supplier_commercial_options_core(uuid,text,text)'::regprocedure);
  old_clause := 'and s.is_active and s.price_usage_enabled';
  new_clause := 'and s.price_usage_enabled';
  if (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause) <> 1 then
    raise exception 'SUPPLIER_MANUAL_CORE_GATE_CHANGED';
  end if;
  execute replace(definition,old_clause,new_clause);

  definition := pg_catalog.pg_get_functiondef('public.cloud_current_supplier_price_options_batch(jsonb)'::regprocedure);
  old_clause := 'and su.is_active and su.price_usage_enabled';
  new_clause := 'and su.price_usage_enabled';
  if (length(definition)-length(replace(definition,old_clause,'')))/length(old_clause) <> 1 then
    raise exception 'SUPPLIER_MANUAL_BATCH_GATE_CHANGED';
  end if;
  execute replace(definition,old_clause,new_clause);
end
$migration$;
notify pgrst, 'reload schema';
