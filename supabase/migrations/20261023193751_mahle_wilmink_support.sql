-- Add Mahle as an explicit supplemental distributor lane. No source or automatic-apply grants are created.
set local lock_timeout='2s';
set local statement_timeout='10s';

do $migration$
declare definition text;
begin
  definition := pg_get_functiondef('start_catalog_wilmink_support(uuid,uuid,uuid,text,jsonb)'::regprocedure);
  if position($old$'Elring','INA'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$'Elring','INA'$old$,$new$'Elring','INA','Mahle'$new$);
  if position($old$when 'INA' then 'wilmink_ina_support_v1'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$when 'INA' then 'wilmink_ina_support_v1'$old$,$new$when 'INA' then 'wilmink_ina_support_v1' when 'Mahle' then 'wilmink_mahle_support_v1'$new$);
  if position($old$'page_url','https://www.wilminkengineparts.com/en/brands/elring'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$'page_url','https://www.wilminkengineparts.com/en/brands/elring'$old$,$new$'page_url','https://www.wilminkengineparts.com/en/brands/'||lower(input_brand)$new$);
  execute definition;
end
$migration$;

do $migration$
declare definition text;
begin
  definition := pg_get_functiondef('complete_catalog_wilmink_support(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
  if position($old$'Elring','INA'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$'Elring','INA'$old$,$new$'Elring','INA','Mahle'$new$);
  if position($old$when 'INA' then 'wilmink_ina_support_v1'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$when 'INA' then 'wilmink_ina_support_v1'$old$,$new$when 'INA' then 'wilmink_ina_support_v1' when 'Mahle' then 'wilmink_mahle_support_v1'$new$);
  if position($old$brand_name<>'Elring'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$brand_name<>'Elring'$old$,$new$brand_name not in('Elring','Mahle')$new$);
  if position($old$!~'^https://www[.]wilminkengineparts[.]com/en/brands/elring([?]page=[1-9][0-9]{0,3})?$'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$!~'^https://www[.]wilminkengineparts[.]com/en/brands/elring([?]page=[1-9][0-9]{0,3})?$'$old$,$new$!~('^https://www[.]wilminkengineparts[.]com/en/brands/'||lower(brand_name)||'([?]page=[1-9][0-9]{0,3})?$')$new$);
  if position($old$'https://www.wilminkengineparts.com/en/brands/elring?page='||(page_no+1)::text$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$'https://www.wilminkengineparts.com/en/brands/elring?page='||(page_no+1)::text$old$,$new$'https://www.wilminkengineparts.com/en/brands/'||lower(brand_name)||'?page='||(page_no+1)::text$new$);
  execute definition;
end
$migration$;

do $migration$
declare definition text;
begin
  definition := pg_get_functiondef('get_catalog_wilmink_support_status(uuid,text)'::regprocedure);
  if position($old$'Elring','INA'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$'Elring','INA'$old$,$new$'Elring','INA','Mahle'$new$);
  execute definition;
end
$migration$;

do $migration$
declare definition text;
begin
  definition := pg_get_functiondef('get_catalog_wilmink_application_progress(uuid,text)'::regprocedure);
  if position($old$'wilmink_ina_support_v1'$old$ in definition)=0 then raise exception 'MAHLE_WILMINK_BASELINE_MISMATCH'; end if;
  definition := replace(definition,$old$'wilmink_ina_support_v1'$old$,$new$'wilmink_ina_support_v1','wilmink_mahle_support_v1'$new$);
  execute definition;
end
$migration$;

select pg_notify('pgrst','reload schema');
