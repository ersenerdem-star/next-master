-- Register source identities without enabling a partial engine or publication.
-- Existing records, products, supplier prices and manual prices are untouched.
insert into public.catalog_external_sources
 (id,organization_id,source_key,display_name,source_owner,source_type,base_url,license_posture,robots_posture,rate_limit_posture,credential_boundary,is_active,metadata)
select gen_random_uuid(),b.organization_id,v.source_key,v.display_name,v.source_owner,v.source_type,v.base_url,
 'internal_review_required','unknown','bounded','none',true,
 jsonb_build_object('allowed_brands',jsonb_build_array('Knorr-Bremse'),
  'allowed_evidence_hosts',jsonb_build_array(v.evidence_host),'brand_engine_read_allowed',false,
  'brand_engine_enrichment_allowed',false,'secondary_wilmink_read_allowed',false,
  'automatic_apply',false,'price_policy','excluded','activation_status','registered_pending_end_to_end_verification')
from (select distinct organization_id from public.brands where name='Knorr-Bremse') b
cross join (values
 ('knorr_bremse_aftermarket','Knorr-Bremse · TruckServices official','Knorr-Bremse','manufacturer','https://mytruckservices.knorr-bremse.com/','mytruckservices.knorr-bremse.com'),
 ('wilmink_knorr_bremse_support_v1','Wilmink · Knorr-Bremse review','Wilmink','external_catalog','https://www.wilminkengineparts.com/','www.wilminkengineparts.com')
) as v(source_key,display_name,source_owner,source_type,base_url,evidence_host)
where not exists(select 1 from public.catalog_external_sources s where s.organization_id=b.organization_id and s.source_key=v.source_key);
