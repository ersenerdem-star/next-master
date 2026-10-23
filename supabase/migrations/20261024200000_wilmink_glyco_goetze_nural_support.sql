set local lock_timeout='2s';
set local statement_timeout='15s';

-- Register only public, brand-scoped Wilmink evidence. These lanes remain
-- review-only until an explicit automatic-apply approval is recorded.
insert into public.catalog_external_sources
 (organization_id,source_key,display_name,base_url,is_active,license_posture,robots_posture,credential_boundary,rate_limit_posture,metadata)
select organization_id,'wilmink_glyco_support_v1','Wilmink Glyco support','https://www.wilminkengineparts.com/en/brands/glyco',true,
 license_posture,robots_posture,credential_boundary,rate_limit_posture,
 jsonb_set(jsonb_set(jsonb_set(metadata,'{allowed_brands}','["Glyco"]'::jsonb),'{listing_available}','true'::jsonb),'{automatic_apply}','false'::jsonb)
from public.catalog_external_sources where source_key='wilmink_mahle_support_v1'
on conflict (organization_id,source_key) do update set base_url=excluded.base_url,is_active=true,metadata=excluded.metadata;

insert into public.catalog_external_sources
 (organization_id,source_key,display_name,base_url,is_active,license_posture,robots_posture,credential_boundary,rate_limit_posture,metadata)
select organization_id,'wilmink_goetze_support_v1','Wilmink Goetze support','https://www.wilminkengineparts.com/en/brands/goetze',true,
 license_posture,robots_posture,credential_boundary,rate_limit_posture,
 jsonb_set(jsonb_set(jsonb_set(metadata,'{allowed_brands}','["Goetze"]'::jsonb),'{listing_available}','true'::jsonb),'{automatic_apply}','false'::jsonb)
from public.catalog_external_sources where source_key='wilmink_mahle_support_v1'
on conflict (organization_id,source_key) do update set base_url=excluded.base_url,is_active=true,metadata=excluded.metadata;

insert into public.catalog_external_sources
 (organization_id,source_key,display_name,base_url,is_active,license_posture,robots_posture,credential_boundary,rate_limit_posture,metadata)
select organization_id,'wilmink_nural_support_v1','Wilmink Nural URL support','https://www.wilminkengineparts.com/en/search-results?keywords=&tags=productBrand:Nural',true,
 license_posture,robots_posture,credential_boundary,rate_limit_posture,
 jsonb_set(jsonb_set(jsonb_set(metadata,'{allowed_brands}','["Nural"]'::jsonb),'{listing_available}','false'::jsonb),'{automatic_apply}','false'::jsonb)
from public.catalog_external_sources where source_key='wilmink_mahle_support_v1'
on conflict (organization_id,source_key) do update set base_url=excluded.base_url,is_active=true,metadata=excluded.metadata;

do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('start_catalog_wilmink_support(uuid,uuid,uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,$old$input_brand not in('Elring','INA','Mahle')$old$,$new$input_brand not in('Elring','INA','Mahle','Glyco','Goetze','Nural')$new$);
 definition:=replace(definition,$old$(input_brand='INA' and jsonb_array_length(input_urls)=0)$old$,$new$(input_brand in('INA','Nural') and jsonb_array_length(input_urls)=0)$new$);
 definition:=replace(definition,$old$when 'Mahle' then 'wilmink_mahle_support_v1'$old$,$new$when 'Mahle' then 'wilmink_mahle_support_v1' when 'Glyco' then 'wilmink_glyco_support_v1' when 'Goetze' then 'wilmink_goetze_support_v1' when 'Nural' then 'wilmink_nural_support_v1'$new$);
 execute definition;
 definition:=pg_get_functiondef('complete_catalog_wilmink_support(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 definition:=replace(definition,$old$not in('Elring','Mahle')$old$,$new$not in('Elring','Mahle','Glyco','Goetze','Nural')$new$);
 definition:=replace(definition,$old$when 'Mahle' then 'wilmink_mahle_support_v1'$old$,$new$when 'Mahle' then 'wilmink_mahle_support_v1' when 'Glyco' then 'wilmink_glyco_support_v1' when 'Goetze' then 'wilmink_goetze_support_v1' when 'Nural' then 'wilmink_nural_support_v1'$new$);
 execute definition;
 definition:=pg_get_functiondef('get_catalog_wilmink_support_status(uuid,text)'::regprocedure);
 definition:=replace(definition,$old$'Elring','INA','Mahle'$old$,$new$'Elring','INA','Mahle','Glyco','Goetze','Nural'$new$);
 execute definition;
 definition:=pg_get_functiondef('get_catalog_wilmink_application_progress(uuid,text)'::regprocedure);
 definition:=replace(definition,$old$'wilmink_mahle_support_v1'$old$,$new$'wilmink_mahle_support_v1','wilmink_glyco_support_v1','wilmink_goetze_support_v1','wilmink_nural_support_v1'$new$);
 execute definition;
end
$migration$;

-- Keep the always-on minute dispatcher aware of the new lanes. It still owns
-- one lease per organization, so adding lanes cannot interrupt active work.
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('admit_catalog_wilmink_application()'::regprocedure);
 definition:=replace(definition,$old$('Nural','wilmink_nural_support_v1','wilmink-support-discovery.v1')$old$,$new$('Nural','wilmink_nural_support_v1','wilmink-support-discovery.v1')$new$);
 -- The baseline tuple list is extended by inserting the two public-listing lanes.
 definition:=replace(definition,$old$('INA','wilmink_ina_support_v1','wilmink-support-discovery.v1'))$old$,$new$('INA','wilmink_ina_support_v1','wilmink-support-discovery.v1'),('Glyco','wilmink_glyco_support_v1','wilmink-support-discovery.v1'),('Goetze','wilmink_goetze_support_v1','wilmink-support-discovery.v1'),('Nural','wilmink_nural_support_v1','wilmink-support-discovery.v1'))$new$);
 execute definition;
 definition:=pg_get_functiondef('apply_catalog_wilmink_automatic_item(uuid,uuid,uuid,integer)'::regprocedure);
 definition:=replace(definition,$old$'wilmink_ina_support_v1')$old$,$new$'wilmink_ina_support_v1','wilmink_glyco_support_v1','wilmink_goetze_support_v1','wilmink_nural_support_v1')$new$);
 execute definition;
 definition:=pg_get_functiondef('next_catalog_brand_dispatch()'::regprocedure);
 execute definition;
end
$migration$;

select pg_notify('pgrst','reload schema');
