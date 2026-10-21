-- Decimal commas are part of existing INA/FAG article identity, not delimiters.
create or replace function public.start_catalog_spareto_correction(input_org uuid,input_actor uuid,input_brand text,input_codes jsonb,input_key uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.catalog_external_sources%rowtype;j public.catalog_brand_jobs%rowtype;b uuid;config jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CORRECTION_SERVICE_REQUIRED';end if;
 select * into s from public.catalog_external_sources where organization_id=input_org and source_key='spareto_schaeffler_correction_v1';
 if input_brand not in ('INA','FAG','LUK') or s.id is null or not s.is_active or s.license_posture not in ('allowed','internal_review_required') or s.credential_boundary<>'none' or s.rate_limit_posture<>'bounded' or s.metadata->'correction_read_allowed' is distinct from 'true'::jsonb
  or s.metadata->'correction_apply_allowed' is distinct from 'true'::jsonb or s.metadata->'allowed_brands' ? input_brand is not true
  or s.metadata->>'approval_actor' is distinct from input_actor::text or nullif(s.metadata->>'publication_approval_reference','') is null
  or nullif(s.metadata->>'approval_expires_at','') is null or (s.metadata->>'approval_expires_at')::timestamptz<=clock_timestamp()
  or not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and is_active and role='superadmin') then raise exception 'CORRECTION_SOURCE_APPROVAL_REQUIRED';end if;
 if jsonb_typeof(input_codes) is distinct from 'array' or jsonb_array_length(input_codes) not between 1 and 100 or input_key is null
  or exists(select 1 from jsonb_array_elements(input_codes) c where jsonb_typeof(c)<>'string' or c#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9 ._+/,-]{0,99}$')
  or (select count(distinct public.normalize_catalog_product_code(value)) from jsonb_array_elements_text(input_codes))<>jsonb_array_length(input_codes) then raise exception 'CORRECTION_CODES_INVALID';end if;
 select id into b from public.brands where organization_id=input_org and name=input_brand;
 if b is null or exists(select 1 from jsonb_array_elements_text(input_codes) v where not exists(select 1 from public.catalog_products p where p.organization_id=input_org and p.brand_id=b and p.normalized_code=public.normalize_part_code(v) and public.normalize_catalog_product_code(p.product_code)=public.normalize_catalog_product_code(v))) then raise exception 'CORRECTION_EXISTING_PRODUCT_REQUIRED';end if;
 config:=jsonb_build_object('codes',input_codes,'brand',input_brand,'brand_id',b,'source_key',s.source_key,'adapter','spareto-reviewed-correction.v1',
  'approval_reference',s.metadata->>'publication_approval_reference','approved_fields',jsonb_build_array('description','oem_no','market_segment','image_url'));
 insert into public.catalog_brand_jobs(organization_id,created_by,idempotency_key,manifest,total_items,mode)
 values(input_org,input_actor,input_key,config,jsonb_array_length(input_codes),'publish') on conflict(organization_id,idempotency_key)do nothing;
 select * into j from public.catalog_brand_jobs where organization_id=input_org and idempotency_key=input_key for update;
 if j.manifest<>config then raise exception 'CORRECTION_IDEMPOTENCY_CONFLICT';end if;
 insert into public.catalog_brand_job_items(job_id,organization_id,item_index,product_code)
 select j.id,input_org,(ordinality-1)::integer,value from jsonb_array_elements_text(input_codes)with ordinality on conflict do nothing;
 return to_jsonb(j)-'lease_token';
end$$;
select pg_notify('pgrst','reload schema');
