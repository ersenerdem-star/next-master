-- Strict provider-stage rows are immutable and densely numbered from zero.
-- Avoid rereading all preceding rows for every guarded enrichment package.
-- Preserve the function's admission rules, timeout, output and execute grants.
set lock_timeout='250ms';set statement_timeout='3s';
do $migration$
declare definition text; updated_definition text;
begin
 definition:=pg_get_functiondef('public.enrich_elring_provider_stage_batch(uuid,uuid,integer,integer)'::regprocedure);
 if position('and row_index >= input_offset' in definition)>0 then return; end if;
 if position('order by row_index limit input_batch_size offset input_offset' in definition)=0
 then raise exception 'Unexpected Elring enrichment implementation'; end if;
 updated_definition:=replace(definition,'order by row_index limit input_batch_size offset input_offset',
  'and row_index >= input_offset order by row_index limit input_batch_size');
 execute updated_definition;
end $migration$;
