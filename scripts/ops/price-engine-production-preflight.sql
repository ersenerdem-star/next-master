-- Read-only metadata snapshot for the price-engine promotion package.
-- Run through a connector/connection explicitly targeting the chosen project.
-- No domain RPC is executed, and no business rows or secrets are returned.
-- Missing objects are reported as missing, never assumed to be compatible.
with
required_tables(phase, name, restricted_browser) as (values
  ('baseline','organizations',false), ('baseline','profiles',false),
  ('baseline','brands',false), ('baseline','suppliers',false),
  ('baseline','customers',false), ('baseline','customer_price_lists',false),
  ('baseline','catalog_products',false), ('baseline','catalog_import_runs',false),
  ('baseline','catalog_import_stage',false), ('baseline','supplier_prices',false),
  ('baseline','supplier_price_rollups',false), ('baseline','supplier_price_import_runs',false),
  ('baseline','sales_orders',false), ('baseline','invoices',false),
  ('runtime','supplier_price_releases',false), ('runtime','supplier_price_release_rows',false),
  ('runtime','supplier_price_release_events',false), ('runtime','supplier_price_release_batches',false),
  ('runtime','supplier_price_upload_sessions',false), ('runtime','supplier_price_publications',false),
  ('runtime','supplier_current_price_pointers',false), ('runtime','catalog_import_sources',false),
  ('runtime','catalog_import_source_batches',false), ('runtime','app_export_jobs',true),
  ('runtime','supplier_price_release_validation_code_counts',false),
  ('runtime','supplier_price_release_validation_runs',false),
  ('runtime','supplier_price_ingestion_internal.handoffs',true),
  ('runtime','supplier_price_ingestion_internal.verification_requests',true),
  ('runtime','supplier_price_ingestion_internal.production_publication_control',true),
  ('runtime','supplier_price_ingestion_internal.production_publication_decisions',true),
  ('runtime','supplier_price_ingestion_internal.production_publication_reversals',true),
  ('runtime','supplier_price_validation_internal.review_decisions',true)
),
table_checks as (
  select r.phase,r.name,r.restricted_browser,r.name not like '%.%' as exposed_schema,
    c.oid is not null as present,
    c.relrowsecurity as rls,
    case when c.oid is not null then has_table_privilege('service_role',c.oid,'SELECT') end as service_select,
    case when c.oid is not null then has_table_privilege('service_role',c.oid,'INSERT') end as service_insert,
    case when c.oid is not null then has_table_privilege('service_role',c.oid,'UPDATE') end as service_update,
    case when c.oid is not null then has_table_privilege('service_role',c.oid,'DELETE') end as service_delete,
    case when c.oid is not null then has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') end as anon_access,
    case when c.oid is not null then has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') end as authenticated_access
  from required_tables r left join pg_class c
    on c.oid=to_regclass(case when r.name like '%.%' then r.name else 'public.'||r.name end)
),
required_columns(phase,table_name,column_name,type_name) as (values
  ('baseline','profiles','is_active','boolean'),
  ('baseline','profiles','session_revoked_at','timestamp with time zone'),
  ('baseline','catalog_import_runs','organization_id','uuid'),
  ('baseline','catalog_import_runs','input_scope','jsonb'),
  ('baseline','catalog_import_stage','run_id','uuid'),
  ('runtime','supplier_price_releases','source_verification_required','boolean'),
  ('runtime','supplier_price_releases','brand_identity_audit','jsonb'),
  ('runtime','supplier_price_releases','review_revision','bigint'),
  ('runtime','supplier_price_release_rows','normalized_code','text'),
  ('runtime','supplier_price_release_rows','product_code','text'),
  ('runtime','supplier_price_release_rows','buy_price','numeric'),
  ('runtime','supplier_price_release_rows','currency','text'),
  ('runtime','supplier_price_release_rows','row_status','text'),
  ('runtime','supplier_current_price_pointers','publication_id','uuid'),
  ('runtime','supplier_current_price_pointers','release_id','uuid'),
  ('runtime','app_export_jobs','organization_id','uuid'),
  ('runtime','app_export_jobs','requested_by','uuid'),
  ('runtime','app_export_jobs','scope','jsonb'),
  ('runtime','app_export_jobs','data_version','text'),
  ('runtime','app_export_jobs','storage_path','text'),
  ('runtime','app_export_jobs','byte_size','integer'),
  ('runtime','app_export_jobs','row_count','integer'),
  ('runtime','app_export_jobs','started_at','timestamp with time zone'),
  ('runtime','app_export_jobs','updated_at','timestamp with time zone'),
  ('runtime','app_export_jobs','worker_lease_owner','text'),
  ('runtime','app_export_jobs','worker_lease_expires_at','timestamp with time zone'),
  ('runtime','catalog_import_sources','lease_token','uuid'),
  ('runtime','catalog_import_sources','lease_generation','bigint'),
  ('runtime','catalog_import_sources','verified_lease_generation','bigint'),
  ('runtime','catalog_import_sources','input_scope','jsonb'),
  ('runtime','supplier_price_ingestion_internal.production_publication_control','expected_project_ref','text'),
  ('runtime','supplier_price_ingestion_internal.production_publication_control','enabled','boolean'),
  ('runtime','supplier_price_ingestion_internal.production_publication_control','activation_decision_id','uuid'),
  ('runtime','supplier_price_ingestion_internal.production_publication_decisions','decision_id','uuid'),
  ('runtime','supplier_price_ingestion_internal.production_publication_decisions','review_revision','bigint'),
  ('runtime','supplier_price_ingestion_internal.production_publication_control','reversal_enabled','boolean')
),
column_checks as (
  select r.*,a.attname is not null as present,
    format_type(a.atttypid,a.atttypmod) as actual_type,
    a.attname is not null and format_type(a.atttypid,null)=r.type_name as compatible
  from required_columns r left join pg_attribute a
    on a.attrelid=to_regclass(case when r.table_name like '%.%' then r.table_name else 'public.'||r.table_name end)
    and a.attname=r.column_name
    and a.attnum>0 and not a.attisdropped
),
required_functions(phase,name,service_only,signature) as (values
  ('baseline','current_profile_org_id',false,'public.current_profile_org_id()'),
  ('baseline','current_profile_role',false,'public.current_profile_role()'),
  ('baseline','begin_catalog_import',false,'public.begin_catalog_import(jsonb,text)'),
  ('baseline','stage_catalog_import_chunk',false,'public.stage_catalog_import_chunk(uuid,jsonb)'),
  ('baseline','finalize_catalog_import',false,'public.finalize_catalog_import(uuid)'),
  ('runtime','get_supplier_price_release_manifest',true,'public.get_supplier_price_release_manifest(uuid)'),
  ('runtime','get_supplier_price_release_status',true,'public.get_supplier_price_release_status(uuid[])'),
  ('runtime','get_supplier_price_upload_status',true,'public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint)'),
  ('runtime','recover_expired_supplier_price_release_batches',true,'public.recover_expired_supplier_price_release_batches(integer)'),
  ('runtime','request_supplier_price_upload_verification',true,'public.request_supplier_price_upload_verification(uuid,uuid,uuid,uuid,bigint,bigint)'),
  ('runtime','start_supplier_price_release_batch_validation',true,'public.start_supplier_price_release_batch_validation(uuid)'),
  ('runtime','start_supplier_price_upload_session',true,'public.start_supplier_price_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)'),
  ('runtime','start_supplier_price_verified_upload_session',true,'public.start_supplier_price_verified_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)'),
  ('runtime','supplier_price_upload_object_is_sealed',false,'public.supplier_price_upload_object_is_sealed(text,text)'),
  ('runtime','validate_supplier_price_release',true,'public.validate_supplier_price_release(uuid)'),
  ('runtime','validate_supplier_price_release_batch',true,'public.validate_supplier_price_release_batch(uuid,integer)'),
  ('runtime','claim_supplier_price_release_batch',true,'public.claim_supplier_price_release_batch(uuid,text,integer,integer)'),
  ('runtime','resume_supplier_price_shadow_finalization',true,'public.resume_supplier_price_shadow_finalization(uuid,text,integer)'),
  ('runtime','supplier_price_current_snapshot',true,'public.supplier_price_current_snapshot(uuid,uuid,uuid,text[])'),
  ('runtime','supplier_price_validation_internal.check_publication_identity',false,'supplier_price_validation_internal.check_publication_identity(uuid,uuid,uuid,uuid)'),
  ('runtime','supplier_price_validation_internal.review_release',false,'supplier_price_validation_internal.review_release(uuid,uuid,uuid,uuid,text,text,bigint,text,text,jsonb)'),
  ('runtime','supplier_price_validation_internal.validate_supplier_price_release',false,'supplier_price_validation_internal.validate_supplier_price_release(uuid)'),
  ('runtime','supplier_price_validation_internal.cross_brand_audit',false,'supplier_price_validation_internal.cross_brand_audit(uuid)'),
  ('runtime','supplier_price_validation_internal.historical_rows_valid',false,'supplier_price_validation_internal.historical_rows_valid(uuid)'),
  ('runtime','claim_supplier_price_upload_verification',true,null),
  ('runtime','settle_supplier_price_upload_verification',true,null),
  ('runtime','begin_supplier_price_upload_verification',true,null),
  ('runtime','complete_supplier_price_verified_upload',true,null),
  ('runtime','claim_supplier_price_verified_handoff',true,null),
  ('runtime','ack_supplier_price_verified_handoff',true,null),
  ('runtime','get_supplier_price_verified_manifest',true,null),
  ('runtime','claim_supplier_price_verified_release_batch',true,null),
  ('runtime','stage_supplier_price_release_batch',true,null),
  ('runtime','heartbeat_supplier_price_release_batch',true,null),
  ('runtime','finalize_supplier_price_release_shadow_batch',true,null),
  ('runtime','complete_supplier_price_release_duckdb_validation',true,
    'public.complete_supplier_price_release_duckdb_validation(uuid,integer,integer,integer,integer,integer,integer,integer,integer)'),
  ('runtime','cloud_current_supplier_price_options_core',true,'public.cloud_current_supplier_price_options_core(uuid,text,text)'),
  ('runtime','cloud_current_supplier_price_options_service',true,'public.cloud_current_supplier_price_options_service(uuid,text,text)'),
  ('runtime','get_catalog_export_version',true,'public.get_catalog_export_version(uuid,uuid,text)'),
  ('runtime','get_catalog_master_export_version',true,'public.get_catalog_master_export_version(uuid,uuid,text)'),
  ('runtime','cloud_catalog_export_chunk_v3',true,'public.cloud_catalog_export_chunk_v3(uuid,uuid,text,uuid,integer)'),
  ('runtime','cloud_catalog_master_export_chunk_v3',true,'public.cloud_catalog_master_export_chunk_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric)'),
  ('runtime','cloud_supplier_price_export_chunk_v3',true,'public.cloud_supplier_price_export_chunk_v3(uuid,uuid,uuid,text,text,text,uuid,integer)'),
  ('runtime','begin_catalog_import_storage',false,'public.begin_catalog_import_storage(jsonb,text,text,text,bigint,text,text)'),
  ('runtime','claim_catalog_import_storage_source_system',true,null),
  ('runtime','heartbeat_catalog_import_storage_source_system',true,null),
  ('runtime','complete_catalog_import_storage_upload_system',true,null),
  ('runtime','stage_catalog_import_storage_batch_system',true,null),
  ('runtime','validate_catalog_import_storage_batch_system',true,'public.validate_catalog_import_storage_batch_system(uuid,uuid,uuid,integer)'),
  ('runtime','finalize_catalog_import_batch_system',true,'public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer)'),
  ('runtime','publish_supplier_price_release_production',true,
    'public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)'),
  ('runtime','reverse_supplier_price_publication_production',true,
    'public.reverse_supplier_price_publication_production(text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint)')
),
function_checks as (
  select r.phase,r.name,r.signature,r.service_only,
    r.name not in ('publish_supplier_price_release_production','reverse_supplier_price_publication_production') as reference_required,
    r.name='supplier_price_upload_object_is_sealed' as authenticated_storage_predicate,
    r.name like 'supplier_price_validation_internal.%' as private_helper,
    r.name in ('supplier_price_validation_internal.cross_brand_audit',
      'supplier_price_validation_internal.historical_rows_valid',
      'supplier_price_validation_internal.validate_supplier_price_release') as owner_only,
    count(p.oid)>0 as present,
    bool_and(has_function_privilege('service_role',p.oid,'EXECUTE')) filter(where p.oid is not null) as service_execute,
    bool_or(has_function_privilege('anon',p.oid,'EXECUTE')) filter(where p.oid is not null) as anon_execute,
    bool_or(has_function_privilege('authenticated',p.oid,'EXECUTE')) filter(where p.oid is not null) as authenticated_execute,
    coalesce(jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
      'definition_md5',md5(pg_get_functiondef(p.oid)), 'security_definer',p.prosecdef,
      'config',p.proconfig)) filter(where p.oid is not null),'[]'::jsonb) as overloads
  from required_functions r left join pg_proc p
    on p.pronamespace=to_regnamespace(case when r.name like '%.%' then split_part(r.name,'.',1) else 'public' end)
    and p.proname=case when r.name like '%.%' then split_part(r.name,'.',2) else r.name end
    and (r.signature is null or p.oid=to_regprocedure(r.signature))
  group by r.phase,r.name,r.signature,r.service_only
),
required_indexes(name) as (values
  ('idx_app_export_jobs_cache_lookup'), ('idx_app_export_jobs_worker_lease'),
  ('idx_catalog_products_export_code_c_id'), ('idx_release_rows_supplier_export_code_c'),
  ('idx_release_rows_master_export_code_c'), ('idx_release_rows_export_exact_eligible_count'),
  ('idx_catalog_import_sources_dispatch'), ('idx_catalog_import_stage_run_validation'),
  ('idx_catalog_import_stage_run_code_brand')
),
index_checks as (
  select r.name,c.oid is not null as present,i.indisvalid as valid,i.indisready as ready,
    case when c.oid is not null then pg_get_indexdef(c.oid) end as definition
  from required_indexes r left join pg_class c on c.oid=to_regclass('public.'||r.name)
  left join pg_index i on i.indexrelid=c.oid
),
required_buckets(name,needs_binary,minimum_limit) as (values
  ('app-exports',true,41943040::bigint),
  ('supplier-price-imports',true,1073741824::bigint),
  ('supplier-price-prepared',true,33554432::bigint),
  ('catalog-imports',true,1073741824::bigint)
),
bucket_checks as (
  select r.*,b.id is not null as present,b.public,b.file_size_limit,b.allowed_mime_types,
    b.id is not null and not b.public as private,
    b.id is not null and (b.file_size_limit is null or b.file_size_limit>=r.minimum_limit) as size_compatible,
    b.id is not null and (b.allowed_mime_types is null or not r.needs_binary
      or 'application/octet-stream'=any(b.allowed_mime_types)) as binary_compatible
  from required_buckets r left join storage.buckets b on b.id=r.name
),
job_constraints as (
  select conname,pg_get_constraintdef(oid) as definition,convalidated as validated
  from pg_constraint where conrelid=to_regclass('public.app_export_jobs') and contype='c'
),
relevant_policies as (
  select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
  from pg_policies where (schemaname='public' and tablename in
    ('app_export_jobs','supplier_price_upload_sessions','supplier_price_releases','catalog_import_sources','catalog_import_source_batches'))
    or (schemaname='storage' and (coalesce(qual,'')||coalesce(with_check,'')) ~ '(catalog-imports|supplier-price-imports|supplier-price-prepared|app-exports)')
),
required_schemas(name) as (values ('supplier_price_ingestion_internal'),('supplier_price_validation_internal')),
schema_checks as (
  select r.name,n.oid is not null as present,
    case when n.oid is not null then has_schema_privilege('anon',n.oid,'USAGE') end as anon_usage,
    case when n.oid is not null then has_schema_privilege('authenticated',n.oid,'USAGE') end as authenticated_usage,
    case when n.oid is not null then has_schema_privilege('service_role',n.oid,'USAGE') end as service_usage
  from required_schemas r left join pg_namespace n on n.nspname=r.name
)
select jsonb_build_object(
  'snapshot_version',1,'collected_at',clock_timestamp(),
  'database',current_database(),'postgres_version',current_setting('server_version'),
  'tables',(select jsonb_agg(to_jsonb(t) order by phase,name) from table_checks t),
  'columns',(select jsonb_agg(to_jsonb(c) order by phase,table_name,column_name) from column_checks c),
  'functions',(select jsonb_agg(to_jsonb(f) order by phase,name) from function_checks f),
  'indexes',(select jsonb_agg(to_jsonb(i) order by name) from index_checks i),
  'buckets',(select jsonb_agg(to_jsonb(b) order by name) from bucket_checks b),
  'job_constraints',(select coalesce(jsonb_agg(to_jsonb(j) order by conname),'[]'::jsonb) from job_constraints j),
  'policies',(select coalesce(jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname),'[]'::jsonb) from relevant_policies p),
  'schemas',(select jsonb_agg(to_jsonb(s) order by name) from schema_checks s),
  'role_settings',(select coalesce(jsonb_agg(jsonb_build_object('role',rolname,'config',rolconfig)),'[]'::jsonb)
    from pg_roles where rolname in ('authenticator','service_role'))
) as price_engine_preflight;
