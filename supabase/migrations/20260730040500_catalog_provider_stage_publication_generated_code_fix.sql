-- catalog_products.normalized_code is GENERATED ALWAYS from product_code.
-- Correct production instances that received the initial publisher definition.
-- Fresh replays already have the corrected definition, so this is a safe no-op.

set lock_timeout = '5s';
set statement_timeout = '60s';

do $migration$
declare
  v_definition text;
  v_fixed_definition text;
begin
  select pg_get_functiondef(p.oid)
    into v_definition
  from pg_proc p
  join pg_namespace n
    on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'publish_catalog_provider_stage_batch'
    and pg_get_function_identity_arguments(p.oid)
      = 'input_run_id uuid, input_brand_id uuid, input_expected_rows integer, input_approval_actor text, input_approval_reference text, input_batch_size integer';

  if v_definition is null then
    raise exception 'publish_catalog_provider_stage_batch was not found';
  end if;

  v_fixed_definition := replace(
    v_definition,
    E'      product_code,\n      normalized_code,\n      description,',
    E'      product_code,\n      description,'
  );

  v_fixed_definition := replace(
    v_fixed_definition,
    E'      s.product_code,\n      s.normalized_code,\n      s.description,',
    E'      s.product_code,\n      s.description,'
  );

  if v_fixed_definition = v_definition then
    if strpos(v_definition, E'      normalized_code,') = 0
       and strpos(v_definition, E'      s.normalized_code,') = 0 then
      return;
    end if;
    raise exception 'Generated normalized_code publication fix did not match the function definition';
  end if;

  execute v_fixed_definition;
end;
$migration$;
