-- Pure metadata SELECT for the one reviewed continuation after rollback22.
-- $1: exact schema-qualified relation names from isolated prebuild+prefix21.
-- $2: exact function signatures from that same fixture. The caller sets
-- search_path=pg_catalog in both sessions before deparsing catalog expressions.
-- No owner names, OIDs, sequence current values, statistics or timestamps enter
-- the comparison. Effective role privileges include inherited/PUBLIC grants.
WITH requested_tables AS (
  SELECT x.name,pg_catalog.to_regclass(x.name) AS oid FROM unnest($1::text[]) AS x(name)
), requested_functions AS (
  SELECT x.signature,pg_catalog.to_regprocedure(x.signature) AS oid FROM unnest($2::text[]) AS x(signature)
), role_names AS (
  SELECT unnest(ARRAY['anon','authenticated','service_role']::text[]) AS name
), tables AS (
  SELECT r.name,c.oid IS NOT NULL AS present,c.relkind::text AS kind,
    c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
    (SELECT jsonb_object_agg(w.name,jsonb_build_object(
      'select',has_table_privilege(w.name,c.oid,'SELECT'),
      'insert',has_table_privilege(w.name,c.oid,'INSERT'),
      'update',has_table_privilege(w.name,c.oid,'UPDATE'),
      'delete',has_table_privilege(w.name,c.oid,'DELETE'),
      'truncate',has_table_privilege(w.name,c.oid,'TRUNCATE'),
      'references',has_table_privilege(w.name,c.oid,'REFERENCES'),
      'trigger',has_table_privilege(w.name,c.oid,'TRIGGER'))) FROM role_names w) AS grants,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'name',a.attname,'position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),
      'not_null',a.attnotnull,'identity',a.attidentity::text,'generated',a.attgenerated::text,
      'default',pg_get_expr(d.adbin,d.adrelid),
      'collation',CASE WHEN a.attcollation<>0 THEN cn.nspname||'.'||co.collname END,
      'column_grants',(SELECT jsonb_object_agg(w.name,jsonb_build_object(
        'select',has_column_privilege(w.name,c.oid,a.attnum,'SELECT'),
        'insert',has_column_privilege(w.name,c.oid,a.attnum,'INSERT'),
        'update',has_column_privilege(w.name,c.oid,a.attnum,'UPDATE'),
        'references',has_column_privilege(w.name,c.oid,a.attnum,'REFERENCES'))) FROM role_names w)
    ) ORDER BY a.attnum),'[]'::jsonb)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',q.conname,'type',q.contype::text,
      'definition',pg_get_constraintdef(q.oid,true),'validated',q.convalidated,
      'deferrable',q.condeferrable,'deferred',q.condeferred) ORDER BY q.conname COLLATE "C"),'[]'::jsonb)
      FROM pg_constraint q WHERE q.conrelid=c.oid) AS constraints,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',i.relname,'definition',pg_get_indexdef(i.oid),
      'valid',x.indisvalid,'ready',x.indisready,'live',x.indislive,'unique',x.indisunique,
      'primary',x.indisprimary,'exclusion',x.indisexclusion) ORDER BY i.relname COLLATE "C"),'[]'::jsonb)
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=c.oid) AS indexes,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd::text,
      'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'public' ELSE ro.rolname END
        ORDER BY (CASE WHEN role_oid=0 THEN 'public' ELSE ro.rolname END) COLLATE "C")
        FROM unnest(p.polroles) v(role_oid) LEFT JOIN pg_roles ro ON ro.oid=v.role_oid),
      'using',pg_get_expr(p.polqual,p.polrelid),'with_check',pg_get_expr(p.polwithcheck,p.polrelid))
      ORDER BY p.polname COLLATE "C"),'[]'::jsonb) FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled::text,
      'definition',pg_get_triggerdef(t.oid,true),'function',t.tgfoid::regprocedure::text)
      ORDER BY t.tgname COLLATE "C"),'[]'::jsonb) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers
  FROM requested_tables r LEFT JOIN pg_class c ON c.oid=r.oid
), functions AS (
  SELECT r.signature,p.oid IS NOT NULL AS present,
    CASE WHEN p.oid IS NOT NULL THEN md5(pg_get_functiondef(p.oid)) END AS definition_md5,
    p.prosecdef AS security_definer,p.proleakproof AS leakproof,p.provolatile::text AS volatility,
    p.proparallel::text AS parallel,p.proisstrict AS strict,p.proretset AS returns_set,
    CASE WHEN p.oid IS NOT NULL THEN pg_get_function_result(p.oid) END AS result,
    CASE WHEN p.oid IS NOT NULL THEN pg_get_function_arguments(p.oid) END AS arguments,
    coalesce((SELECT jsonb_agg(v ORDER BY v COLLATE "C") FROM unnest(p.proconfig) v),'[]'::jsonb) AS config,
    (SELECT jsonb_object_agg(w.name,has_function_privilege(w.name,p.oid,'EXECUTE')) FROM role_names w) AS execute
  FROM requested_functions r LEFT JOIN pg_proc p ON p.oid=r.oid
), schema_names AS (
  SELECT DISTINCT n.nspname AS name FROM requested_tables r JOIN pg_class c ON c.oid=r.oid
    JOIN pg_namespace n ON n.oid=c.relnamespace
  UNION
  SELECT DISTINCT n.nspname FROM requested_functions r JOIN pg_proc p ON p.oid=r.oid
    JOIN pg_namespace n ON n.oid=p.pronamespace
), schemas AS (
  SELECT s.name,(SELECT jsonb_object_agg(w.name,jsonb_build_object(
    'usage',has_schema_privilege(w.name,s.name,'USAGE'),'create',has_schema_privilege(w.name,s.name,'CREATE')))
    FROM role_names w) AS grants FROM schema_names s
)
SELECT jsonb_build_object(
  'snapshot_version',1,
  'scope_valid',cardinality($1::text[])>0 AND cardinality($2::text[])>0
    AND cardinality($1::text[])=(SELECT count(DISTINCT name) FROM requested_tables)
    AND cardinality($2::text[])=(SELECT count(DISTINCT signature) FROM requested_functions),
  'tables',(SELECT jsonb_agg(to_jsonb(t) ORDER BY name COLLATE "C") FROM tables t),
  'functions',(SELECT jsonb_agg(to_jsonb(f) ORDER BY signature COLLATE "C") FROM functions f),
  'schemas',(SELECT jsonb_agg(to_jsonb(s) ORDER BY name COLLATE "C") FROM schemas s),
  'migration22_not_applied',jsonb_build_object(
    'assert_helper_absent',to_regprocedure('public.assert_legacy_supplier_price_write_allowed(text)') IS NULL,
    'trigger_helper_absent',to_regprocedure('public.reject_legacy_supplier_price_published_write()') IS NULL,
    'table_trigger_absent',NOT EXISTS(SELECT 1 FROM pg_trigger WHERE
      tgrelid='public.supplier_prices'::regclass AND tgname='supplier_prices_reject_published_legacy_write'),
    'begin_wrapper_baseline',(SELECT md5(pg_get_functiondef(oid))='b7fe83bd4f4c71928329fd8539951af4'
      FROM pg_proc WHERE oid=to_regprocedure('public.begin_supplier_price_import(text,text,text)')),
    'bulk_wrapper_baseline',(SELECT md5(pg_get_functiondef(oid))='69960fde5d5d5e59e0ec916ffd477f01'
      FROM pg_proc WHERE oid=to_regprocedure('public.bulk_import_supplier_prices(jsonb)')),
    'foundation_pointer_index_present',EXISTS(SELECT 1 FROM pg_index WHERE
      indexrelid=to_regclass('public.idx_supplier_current_price_pointers_org_brand') AND indisvalid AND indisready)
  ),
  'empty_new_workflow_state',jsonb_build_object(
    'releases',(SELECT count(*)=0 FROM public.supplier_price_releases),
    'rows',(SELECT count(*)=0 FROM public.supplier_price_release_rows),
    'batches',(SELECT count(*)=0 FROM public.supplier_price_release_batches),
    'events',(SELECT count(*)=0 FROM public.supplier_price_release_events),
    'uploads',(SELECT count(*)=0 FROM public.supplier_price_upload_sessions),
    'pointers',(SELECT count(*)=0 FROM public.supplier_current_price_pointers),
    'publications',(SELECT count(*)=0 FROM public.supplier_price_publications),
    'handoffs',(SELECT count(*)=0 FROM supplier_price_ingestion_internal.handoffs),
    'verification_requests',(SELECT count(*)=0 FROM supplier_price_ingestion_internal.verification_requests),
    'publication_decisions',(SELECT count(*)=0 FROM supplier_price_ingestion_internal.production_publication_decisions),
    'publication_reversals',(SELECT count(*)=0 FROM supplier_price_ingestion_internal.production_publication_reversals)
  ),
  'publication_controls_off',(SELECT count(*)=1 AND bool_and(NOT enabled AND NOT reversal_enabled
    AND expected_project_ref='zjgueqijumzlfioihnkt' AND activation_decision_id IS NULL
    AND activated_by IS NULL AND activated_at IS NULL)
    FROM supplier_price_ingestion_internal.production_publication_control),
  'ersen_unchanged_c_null_margin',EXISTS(SELECT 1 FROM public.customers
    WHERE id='fd9f8834-7935-4050-8895-fde8a2eb4914'::uuid
      AND organization_id='1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
      AND price_list_type='C' AND price_list_margin_percent IS NULL)
) AS resume22_snapshot;
