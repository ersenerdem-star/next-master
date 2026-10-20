-- Operator-only continuation authorized by user on 2026-10-20.
-- Execute ONE batch per transaction. Check Auth and REST health (<2s) at
-- least every five batches. Stop on any error or database_ms > 2000.
-- Never retry an ambiguous response without rereading publication cursor.
-- Source activation is transaction-local: concurrent sessions continue to see
-- the paused source. Failure rolls back activation, products and cursor.
set statement_timeout='3s';
set lock_timeout='250ms';
do $recovery$
declare result jsonb; started timestamptz:=clock_timestamp();
begin
 perform set_config('request.jwt.claim.role','service_role',true);
 if not exists(select 1 from public.catalog_external_sources
   where id='5e08b5d3-5628-4196-8be8-4b9f5badfd5e' and is_active=false
   and metadata->>'internal_catalog_persistence_allowed'='true')
 then raise exception 'Paused Elring scope changed'; end if;
 update public.catalog_external_sources set is_active=true
   where id='5e08b5d3-5628-4196-8be8-4b9f5badfd5e';
 result:=public.publish_catalog_provider_stage_batch(
   'cc0695cd-eb9f-43ef-9a3e-1371834fdb7f',
   '1412aa4b-5518-427c-9de1-264758bb6811',21543,
   'Next-Master Product Decision Owner',
   'codex-elring-catalog-publish-user-instruction-2026-10-19',25);
 update public.catalog_external_sources set is_active=false,
   metadata=metadata||jsonb_build_object(
     'bounded_recovery_approval','user-complete-missing-products-2026-10-20',
     'bounded_recovery_at',now())
   where id='5e08b5d3-5628-4196-8be8-4b9f5badfd5e';
 perform set_config('elring.recovery_result',
   (result||jsonb_build_object('database_ms',
     extract(epoch from clock_timestamp()-started)*1000))::text,true);
end $recovery$;
select current_setting('elring.recovery_result')::jsonb as result;
