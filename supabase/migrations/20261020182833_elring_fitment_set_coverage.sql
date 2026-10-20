-- Compare target sets once. Correlating a JSON scan for every target makes
-- common seal-ring fitments quadratic when thousands of vehicles are linked.
set statement_timeout='3s';set lock_timeout='250ms';
do $migration$
declare definition text; previous text; replacement text;
begin
 definition:=pg_get_functiondef('public.apply_elring_complete_vehicle_fitment(uuid,integer,jsonb)'::regprocedure);
 previous:=$old$if exists(select 1 from jsonb_array_elements(input_evidence->'vehicles') v
    where not exists(select 1 from jsonb_array_elements(input_evidence->'coverage') c
     where c->'target_keys' ? ((v->>'target_type')||':'||(v->>'target_id'))))
  or exists(select 1 from jsonb_array_elements(input_evidence->'coverage') c,
    lateral jsonb_array_elements_text(c->'target_keys') k
    where not exists(select 1 from jsonb_array_elements(input_evidence->'vehicles') v
     where (v->>'target_type')||':'||(v->>'target_id')=k.value))$old$;
 replacement:=$new$if exists(
  with vehicle_keys as materialized (
   select (v->>'target_type')||':'||(v->>'target_id') as target_key
   from jsonb_array_elements(input_evidence->'vehicles') v
  ), linkage_keys as materialized (
   select k.value as target_key from jsonb_array_elements(input_evidence->'coverage') c,
    lateral jsonb_array_elements_text(c->'target_keys') k
  )
  select 1 from (
   (select target_key from vehicle_keys except select target_key from linkage_keys)
   union all
   (select target_key from linkage_keys except select target_key from vehicle_keys)
  ) missing_targets
 )$new$;
 if position(previous in definition)=0 then raise exception 'Unexpected vehicle coverage implementation'; end if;
 execute replace(definition,previous,replacement);
end $migration$;
