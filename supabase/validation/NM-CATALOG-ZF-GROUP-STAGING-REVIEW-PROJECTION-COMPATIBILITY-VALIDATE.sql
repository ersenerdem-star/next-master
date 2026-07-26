\set ON_ERROR_STOP on

begin;

set local statement_timeout = '5min';
set local lock_timeout = '10s';

create temporary table zf_staging_review_projection_gate_results (
  gate text primary key,
  status text not null check (status in ('PASS', 'REJECTED')),
  detail text not null
) on commit drop;

grant select, insert
on table zf_staging_review_projection_gate_results
to authenticated, anon, service_role;

do $zf_projection_shape$
declare
  v_columns text[];
  v_expected constant text[] := array[
    'id',
    'organization_id',
    'brand_id',
    'brand',
    'proposed_display_code',
    'normalized_code',
    'official_source_display_code',
    'official_comparison_key',
    'description',
    'ean',
    'hs_code',
    'origin',
    'weight_kg',
    'oem_references',
    'vehicle_applications',
    'fitment_facts',
    'engine_facts',
    'lifecycle_status',
    'lifecycle_note',
    'replacement_candidates',
    'supersession_candidates',
    'official_image_candidate_url',
    'official_image_evidence_reference',
    'official_source_url',
    'observed_at',
    'evidence_hash',
    'payload_fingerprint',
    'observation_fingerprint',
    'candidate_version',
    'supersedes_candidate_id',
    'quarantine_class',
    'limitation_flags',
    'source_schema_version',
    'runtime_commit',
    'deploy_id',
    'created_at',
    'latest_event_type',
    'latest_event_version',
    'latest_event_reason_code',
    'latest_event_at',
    'run_id',
    'job_id',
    'source_id',
    'contract_version'
  ];
begin
  select array_agg(column_name order by ordinal_position)
  into v_columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'catalog_zf_new_product_staging_review_v';

  insert into zf_staging_review_projection_gate_results
  values (
    '01_exact_projection_shape',
    case when v_columns = v_expected then 'PASS' else 'REJECTED' end,
    case
      when v_columns = v_expected
        then 'existing 40-column allowlist is preserved and four accepted identities are appended'
      else format('unexpected projection columns: %s', coalesce(v_columns::text, '<missing>'))
    end
  );
end;
$zf_projection_shape$;

do $zf_projection_security$
declare
  v_security_invoker boolean;
  v_authenticated_select boolean;
  v_anon_select boolean;
  v_service_role_select boolean;
  v_public_select boolean;
  v_write_grant_count integer;
  v_candidate_rls boolean;
  v_event_rls boolean;
begin
  select coalesce('security_invoker=true' = any(class.reloptions), false)
  into v_security_invoker
  from pg_class class
  join pg_namespace namespace on namespace.oid = class.relnamespace
  where namespace.nspname = 'public'
    and class.relname = 'catalog_zf_new_product_staging_review_v'
    and class.relkind = 'v';

  v_authenticated_select := has_table_privilege(
    'authenticated',
    'public.catalog_zf_new_product_staging_review_v',
    'SELECT'
  );
  v_anon_select := has_table_privilege(
    'anon',
    'public.catalog_zf_new_product_staging_review_v',
    'SELECT'
  );
  v_service_role_select := has_table_privilege(
    'service_role',
    'public.catalog_zf_new_product_staging_review_v',
    'SELECT'
  );

  select exists (
    select 1
    from information_schema.table_privileges privilege
    where privilege.table_schema = 'public'
      and privilege.table_name = 'catalog_zf_new_product_staging_review_v'
      and privilege.grantee = 'PUBLIC'
      and privilege.privilege_type = 'SELECT'
  )
  into v_public_select;

  select count(*)::integer
  into v_write_grant_count
  from information_schema.table_privileges privilege
  where privilege.table_schema = 'public'
    and privilege.table_name = 'catalog_zf_new_product_staging_review_v'
    and privilege.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
    and privilege.privilege_type in (
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    );

  select class.relrowsecurity
  into v_candidate_rls
  from pg_class class
  where class.oid = 'public.catalog_new_product_staging_candidates'::regclass;

  select class.relrowsecurity
  into v_event_rls
  from pg_class class
  where class.oid = 'public.catalog_new_product_staging_events'::regclass;

  insert into zf_staging_review_projection_gate_results
  values (
    '02_security_invoker_and_exact_grants',
    case
      when v_security_invoker
       and v_authenticated_select
       and not v_anon_select
       and not v_service_role_select
       and not v_public_select
       and v_write_grant_count = 0
       and v_candidate_rls
       and v_event_rls
        then 'PASS'
      else 'REJECTED'
    end,
    format(
      'security_invoker=%s authenticated_select=%s anon_select=%s service_role_select=%s public_select=%s write_grants=%s candidate_rls=%s event_rls=%s',
      v_security_invoker,
      v_authenticated_select,
      v_anon_select,
      v_service_role_select,
      v_public_select,
      v_write_grant_count,
      v_candidate_rls,
      v_event_rls
    )
  );
end;
$zf_projection_security$;

insert into public.organizations (id, name)
values
  ('76000000-0000-4000-8000-000000000001', 'ZF Projection Validation Tenant'),
  ('77000000-0000-4000-8000-000000000001', 'ZF Projection Other Tenant');

insert into public.profiles (id, organization_id, email, full_name, role, is_active)
values
  (
    '76000000-0000-4000-8000-000000000002',
    '76000000-0000-4000-8000-000000000001',
    'zf-projection-superadmin@example.invalid',
    'ZF Projection Superadmin',
    'superadmin',
    true
  ),
  (
    '76000000-0000-4000-8000-000000000003',
    '76000000-0000-4000-8000-000000000001',
    'zf-projection-admin@example.invalid',
    'ZF Projection Admin',
    'admin',
    true
  ),
  (
    '76000000-0000-4000-8000-000000000004',
    '76000000-0000-4000-8000-000000000001',
    'zf-projection-viewer@example.invalid',
    'ZF Projection Viewer',
    'viewer',
    true
  ),
  (
    '77000000-0000-4000-8000-000000000002',
    '77000000-0000-4000-8000-000000000001',
    'zf-projection-other@example.invalid',
    'ZF Projection Other Superadmin',
    'superadmin',
    true
  );

insert into public.brands (id, organization_id, name)
values
  (
    '76000000-0000-4000-8000-000000000010',
    '76000000-0000-4000-8000-000000000001',
    'ZF'
  ),
  (
    '77000000-0000-4000-8000-000000000010',
    '77000000-0000-4000-8000-000000000001',
    'ZF'
  );

insert into public.catalog_external_sources (
  id,
  organization_id,
  source_key,
  display_name,
  source_type,
  base_url,
  license_posture,
  robots_posture,
  rate_limit_posture,
  credential_boundary
)
values
  (
    '76000000-0000-4000-8000-000000000020',
    '76000000-0000-4000-8000-000000000001',
    'zf_aftermarket',
    'ZF Projection Validation',
    'manufacturer',
    'https://aftermarket.zf.com',
    'allowed',
    'allowed',
    'bounded',
    'no provider credential'
  ),
  (
    '77000000-0000-4000-8000-000000000020',
    '77000000-0000-4000-8000-000000000001',
    'zf_aftermarket',
    'ZF Projection Validation',
    'manufacturer',
    'https://aftermarket.zf.com',
    'allowed',
    'allowed',
    'bounded',
    'no provider credential'
  );

insert into public.catalog_external_source_trust_profiles (
  id,
  organization_id,
  source_id,
  trust_level
)
values
  (
    '76000000-0000-4000-8000-000000000030',
    '76000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000020',
    'T2'
  ),
  (
    '77000000-0000-4000-8000-000000000030',
    '77000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000020',
    'T2'
  );

insert into public.catalog_observation_jobs (
  id,
  organization_id,
  source_id,
  trust_profile_id,
  brand_id,
  job_key,
  status
)
values
  (
    '76000000-0000-4000-8000-000000000040',
    '76000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000020',
    '76000000-0000-4000-8000-000000000030',
    '76000000-0000-4000-8000-000000000010',
    'zf-projection-validation',
    'active'
  ),
  (
    '77000000-0000-4000-8000-000000000040',
    '77000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000020',
    '77000000-0000-4000-8000-000000000030',
    '77000000-0000-4000-8000-000000000010',
    'zf-projection-validation',
    'active'
  );

insert into public.catalog_observation_runs (
  id,
  organization_id,
  job_id,
  source_id,
  brand_id,
  status,
  finished_at,
  contract_version,
  idempotency_key,
  request_fingerprint,
  provider_key,
  runtime_commit,
  requested_candidate_limit,
  effective_candidate_limit,
  redaction_profile_version,
  runtime_policy_version,
  completion_class
)
values
  (
    '76000000-0000-4000-8000-000000000050',
    '76000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000040',
    '76000000-0000-4000-8000-000000000020',
    '76000000-0000-4000-8000-000000000010',
    'succeeded',
    now(),
    '1.0.0',
    'zf-projection-validation-one',
    repeat('3', 64),
    'zf_aftermarket',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    1,
    1,
    'catalog-source-evidence-redaction.v1',
    'zf-staging-runtime-ingestion.v1',
    'SUCCEEDED'
  ),
  (
    '77000000-0000-4000-8000-000000000050',
    '77000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000040',
    '77000000-0000-4000-8000-000000000020',
    '77000000-0000-4000-8000-000000000010',
    'succeeded',
    now(),
    '1.0.0',
    'zf-projection-validation-two',
    repeat('4', 64),
    'zf_aftermarket',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    1,
    1,
    'catalog-source-evidence-redaction.v1',
    'zf-staging-runtime-ingestion.v1',
    'SUCCEEDED'
  );

insert into public.catalog_new_product_staging_candidates (
  id,
  organization_id,
  source_id,
  brand_id,
  job_id,
  run_id,
  sequence_no,
  contract_version,
  candidate_version,
  proposed_display_code,
  normalized_code,
  official_source_display_code,
  official_comparison_key,
  official_source_reference,
  official_source_url,
  observed_at,
  evidence_hash,
  payload_fingerprint,
  observation_fingerprint,
  source_schema_version,
  runtime_commit,
  redaction_profile_version
)
values
  (
    '76000000-0000-4000-8000-000000000060',
    '76000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000020',
    '76000000-0000-4000-8000-000000000010',
    '76000000-0000-4000-8000-000000000040',
    '76000000-0000-4000-8000-000000000050',
    1,
    '1.0.0',
    1,
    'ZF-PROJECTION-ONE',
    'ZF-PROJECTION-ONE',
    'ZF-PROJECTION-ONE',
    'ZFPROJECTIONONE',
    'zf-projection-one',
    'https://aftermarket.zf.com/fixture/zf-projection-one',
    now(),
    repeat('a', 64),
    repeat('b', 64),
    repeat('c', 64),
    'projection-validation.v1',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    'catalog-source-evidence-redaction.v1'
  ),
  (
    '77000000-0000-4000-8000-000000000060',
    '77000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000020',
    '77000000-0000-4000-8000-000000000010',
    '77000000-0000-4000-8000-000000000040',
    '77000000-0000-4000-8000-000000000050',
    1,
    '1.0.0',
    1,
    'ZF-PROJECTION-TWO',
    'ZF-PROJECTION-TWO',
    'ZF-PROJECTION-TWO',
    'ZFPROJECTIONTWO',
    'zf-projection-two',
    'https://aftermarket.zf.com/fixture/zf-projection-two',
    now(),
    repeat('d', 64),
    repeat('e', 64),
    repeat('f', 64),
    'projection-validation.v1',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    'catalog-source-evidence-redaction.v1'
  );

insert into public.catalog_new_product_staging_events (
  organization_id,
  candidate_id,
  event_version,
  expected_prior_version,
  event_type,
  reason_code,
  idempotency_key,
  event_fingerprint
)
values
  (
    '76000000-0000-4000-8000-000000000001',
    '76000000-0000-4000-8000-000000000060',
    1,
    0,
    'STAGED',
    'PROJECTION_VALIDATION',
    'zf-projection-validation-one',
    repeat('1', 64)
  ),
  (
    '77000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000060',
    1,
    0,
    'STAGED',
    'PROJECTION_VALIDATION',
    'zf-projection-validation-two',
    repeat('2', 64)
  );

select set_config(
  'request.jwt.claim.sub',
  '76000000-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $zf_superadmin_same_tenant$
declare
  v_count integer;
  v_identity_count integer;
begin
  select count(*)::integer
  into v_count
  from public.catalog_zf_new_product_staging_review_v;

  select count(*)::integer
  into v_identity_count
  from public.catalog_zf_new_product_staging_review_v
  where id = '76000000-0000-4000-8000-000000000060'
    and organization_id = '76000000-0000-4000-8000-000000000001'
    and run_id = '76000000-0000-4000-8000-000000000050'
    and job_id = '76000000-0000-4000-8000-000000000040'
    and source_id = '76000000-0000-4000-8000-000000000020'
    and contract_version = '1.0.0'
    and latest_event_type = 'STAGED'
    and not exists (
      select 1
      from public.catalog_zf_new_product_staging_review_v other
      where other.organization_id <> '76000000-0000-4000-8000-000000000001'
    );

  insert into zf_staging_review_projection_gate_results
  values (
    '03_superadmin_same_tenant_and_cross_tenant_isolation',
    case when v_count = 1 and v_identity_count = 1 then 'PASS' else 'REJECTED' end,
    format('visible_rows=%s exact_identity_rows=%s', v_count, v_identity_count)
  );
end;
$zf_superadmin_same_tenant$;

reset role;

select set_config(
  'request.jwt.claim.sub',
  '76000000-0000-4000-8000-000000000003',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $zf_admin_same_tenant$
declare
  v_count integer;
begin
  select count(*)::integer
  into v_count
  from public.catalog_zf_new_product_staging_review_v
  where organization_id = '76000000-0000-4000-8000-000000000001';

  insert into zf_staging_review_projection_gate_results
  values (
    '04_admin_same_tenant',
    case when v_count = 1 then 'PASS' else 'REJECTED' end,
    format(
      'accepted boundary requires one same-tenant row for admin; visible_rows=%s',
      v_count
    )
  );
end;
$zf_admin_same_tenant$;

reset role;

select set_config(
  'request.jwt.claim.sub',
  '76000000-0000-4000-8000-000000000004',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $zf_non_admin_denied$
declare
  v_count integer;
begin
  select count(*)::integer
  into v_count
  from public.catalog_zf_new_product_staging_review_v;

  insert into zf_staging_review_projection_gate_results
  values (
    '05_non_admin_zero_rows',
    case when v_count = 0 then 'PASS' else 'REJECTED' end,
    format('viewer_visible_rows=%s', v_count)
  );
end;
$zf_non_admin_denied$;

reset role;

select set_config(
  'request.jwt.claim.sub',
  '77000000-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $zf_other_tenant_isolation$
declare
  v_count integer;
  v_wrong_tenant_count integer;
begin
  select count(*)::integer
  into v_count
  from public.catalog_zf_new_product_staging_review_v;

  select count(*)::integer
  into v_wrong_tenant_count
  from public.catalog_zf_new_product_staging_review_v
  where organization_id <> '77000000-0000-4000-8000-000000000001';

  insert into zf_staging_review_projection_gate_results
  values (
    '06_other_tenant_isolation',
    case when v_count = 1 and v_wrong_tenant_count = 0 then 'PASS' else 'REJECTED' end,
    format('visible_rows=%s wrong_tenant_rows=%s', v_count, v_wrong_tenant_count)
  );
end;
$zf_other_tenant_isolation$;

reset role;
set local role anon;

do $zf_anon_view_denied$
begin
  begin
    perform 1
    from public.catalog_zf_new_product_staging_review_v
    limit 1;

    insert into zf_staging_review_projection_gate_results
    values (
      '07_anon_view_denied',
      'REJECTED',
      'anon unexpectedly read the staging review projection'
    );
  exception
    when insufficient_privilege then
      insert into zf_staging_review_projection_gate_results
      values (
        '07_anon_view_denied',
        'PASS',
        'anon SELECT is denied at the view grant boundary'
      );
  end;
end;
$zf_anon_view_denied$;

reset role;
set local role service_role;

do $zf_service_role_view_denied$
begin
  begin
    perform 1
    from public.catalog_zf_new_product_staging_review_v
    limit 1;

    insert into zf_staging_review_projection_gate_results
    values (
      '08_service_role_view_denied',
      'REJECTED',
      'service_role unexpectedly read the staging review projection'
    );
  exception
    when insufficient_privilege then
      insert into zf_staging_review_projection_gate_results
      values (
        '08_service_role_view_denied',
        'PASS',
        'service_role SELECT is denied at the view grant boundary'
      );
  end;
end;
$zf_service_role_view_denied$;

reset role;

select set_config(
  'request.jwt.claim.sub',
  '76000000-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local enable_seqscan = off;
set local role authenticated;

do $zf_bounded_projection_plans$
declare
  v_plan text := '';
  v_line text;
  v_unbounded boolean := false;
begin
  for v_line in execute $plan$
    explain (format text)
    select id
    from public.catalog_zf_new_product_staging_review_v
    where id = '76000000-0000-4000-8000-000000000060'
  $plan$
  loop
    v_plan := v_plan || E'\n' || v_line;
  end loop;
  v_unbounded := v_unbounded
    or v_plan like '%Seq Scan on catalog_new_product_staging_candidates%';

  v_plan := '';
  for v_line in execute $plan$
    explain (format text)
    select id
    from public.catalog_zf_new_product_staging_review_v
    where organization_id = '76000000-0000-4000-8000-000000000001'
      and run_id = '76000000-0000-4000-8000-000000000050'
    order by created_at, id
    limit 50
  $plan$
  loop
    v_plan := v_plan || E'\n' || v_line;
  end loop;
  v_unbounded := v_unbounded
    or v_plan like '%Seq Scan on catalog_new_product_staging_candidates%';

  v_plan := '';
  for v_line in execute $plan$
    explain (format text)
    select id
    from public.catalog_zf_new_product_staging_review_v
    where organization_id = '76000000-0000-4000-8000-000000000001'
      and brand = 'ZF'
      and latest_event_type = 'STAGED'
      and quarantine_class is null
    order by created_at, id
    limit 50
  $plan$
  loop
    v_plan := v_plan || E'\n' || v_line;
  end loop;
  v_unbounded := v_unbounded
    or v_plan like '%Seq Scan on catalog_new_product_staging_candidates%'
    or v_plan like '%Seq Scan on catalog_new_product_staging_events%';

  insert into zf_staging_review_projection_gate_results
  values (
    '09_bounded_projection_query_plans',
    case when not v_unbounded then 'PASS' else 'REJECTED' end,
    case
      when not v_unbounded
        then 'candidate, run/cursor, and brand/event/quarantine plans avoid staging/event sequential scans'
      else 'at least one accepted bounded projection query used a staging/event sequential scan'
    end
  );
end;
$zf_bounded_projection_plans$;

reset role;
reset enable_seqscan;

do $zf_no_canonical_mutation$
declare
  v_product_count integer;
  v_review_count integer;
  v_apply_count integer;
begin
  select count(*)::integer
  into v_product_count
  from public.catalog_products
  where organization_id in (
    '76000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000001'
  );

  select count(*)::integer
  into v_review_count
  from public.catalog_observation_review_decisions
  where organization_id in (
    '76000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000001'
  );

  select count(*)::integer
  into v_apply_count
  from public.catalog_apply_events
  where organization_id in (
    '76000000-0000-4000-8000-000000000001',
    '77000000-0000-4000-8000-000000000001'
  );

  insert into zf_staging_review_projection_gate_results
  values (
    '10_no_product_review_guardian_or_apply_mutation',
    case
      when v_product_count = 0 and v_review_count = 0 and v_apply_count = 0
        then 'PASS'
      else 'REJECTED'
    end,
    format(
      'products=%s review_decisions=%s apply_events=%s; validator creates no canonical or decision state',
      v_product_count,
      v_review_count,
      v_apply_count
    )
  );
end;
$zf_no_canonical_mutation$;

select bool_or(status = 'REJECTED') as validator_failed
from zf_staging_review_projection_gate_results
\gset

select gate, status, detail
from zf_staging_review_projection_gate_results
order by gate;

rollback;

\if :validator_failed
  \echo 'ZF staging review projection compatibility validation rejected'
  select 1 / 0 as validator_rejected;
\endif
