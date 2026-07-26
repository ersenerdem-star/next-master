\set ON_ERROR_STOP on

begin;

set local statement_timeout = '10min';
set local lock_timeout = '10s';

create temporary table zf_durable_gate_results (
  gate text primary key,
  status text not null,
  detail text not null
) on commit drop;

insert into public.organizations (id, name)
values
  ('73000000-0000-4000-8000-000000000001', 'ZF Durable Validation Tenant'),
  ('74000000-0000-4000-8000-000000000001', 'ZF Durable Other Tenant');

insert into public.profiles (id, organization_id, email, full_name, role, is_active)
values
  (
    '73000000-0000-4000-8000-000000000002',
    '73000000-0000-4000-8000-000000000001',
    'zf-durable-admin@example.invalid',
    'ZF Durable Admin',
    'superadmin',
    true
  ),
  (
    '74000000-0000-4000-8000-000000000002',
    '74000000-0000-4000-8000-000000000001',
    'zf-durable-other@example.invalid',
    'ZF Durable Other',
    'superadmin',
    true
  );

insert into public.brands (id, organization_id, name)
values
  (
    '73000000-0000-4000-8000-000000000010',
    '73000000-0000-4000-8000-000000000001',
    'ZF'
  ),
  (
    '73000000-0000-4000-8000-000000000011',
    '73000000-0000-4000-8000-000000000001',
    'TRW'
  ),
  (
    '73000000-0000-4000-8000-000000000012',
    '73000000-0000-4000-8000-000000000001',
    'TRW Engine Components'
  ),
  (
    '73000000-0000-4000-8000-000000000013',
    '73000000-0000-4000-8000-000000000001',
    'Lemforder'
  ),
  (
    '74000000-0000-4000-8000-000000000010',
    '74000000-0000-4000-8000-000000000001',
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
  credential_boundary,
  is_active
)
values
  (
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000001',
    'zf_aftermarket',
    'ZF Aftermarket',
    'manufacturer',
    'https://aftermarket.zf.com',
    'allowed',
    'allowed',
    'bounded',
    'provider receives no Next-Master credential',
    true
  ),
  (
    '74000000-0000-4000-8000-000000000020',
    '74000000-0000-4000-8000-000000000001',
    'zf_aftermarket',
    'ZF Aftermarket',
    'manufacturer',
    'https://aftermarket.zf.com',
    'allowed',
    'allowed',
    'bounded',
    'provider receives no Next-Master credential',
    true
  );

insert into public.catalog_external_source_trust_profiles (
  id,
  organization_id,
  source_id,
  trust_level,
  trust_score,
  allowed_field_families,
  auto_enrichment_allowed_fields,
  human_review_required,
  downstream_publication_restriction,
  evidence_required,
  is_active
)
values
  (
    '73000000-0000-4000-8000-000000000030',
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    'T2',
    0.90000,
    array[
      'product_identity',
      'supplemental_description',
      'ean',
      'hs_code',
      'origin',
      'weight',
      'oem_reference',
      'fitment',
      'image_reference'
    ]::text[],
    array[]::text[],
    true,
    'internal_only',
    true,
    true
  ),
  (
    '74000000-0000-4000-8000-000000000030',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000020',
    'T2',
    0.90000,
    array['product_identity']::text[],
    array[]::text[],
    true,
    'internal_only',
    true,
    true
  );

insert into public.catalog_observation_jobs (
  id,
  organization_id,
  source_id,
  trust_profile_id,
  brand_id,
  job_key,
  status,
  observation_scope,
  sync_mode,
  allowed_field_families,
  max_observations_per_run,
  max_retry_attempts,
  lock_timeout_seconds,
  checkpoint_cursor,
  metadata
)
values
  (
    '73000000-0000-4000-8000-000000000040',
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000030',
    '73000000-0000-4000-8000-000000000010',
    'zf-durable-zf-validation',
    'active',
    'single_brand',
    'observation_only',
    array['product_identity']::text[],
    100,
    3,
    600,
    '{}'::jsonb,
    '{"sourceMode":"zf_aftermarket_official_only"}'::jsonb
  ),
  (
    '73000000-0000-4000-8000-000000000041',
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000030',
    '73000000-0000-4000-8000-000000000011',
    'zf-durable-trw-validation',
    'active',
    'single_brand',
    'observation_only',
    array['product_identity']::text[],
    100,
    3,
    600,
    '{}'::jsonb,
    '{"sourceMode":"zf_aftermarket_official_only"}'::jsonb
  ),
  (
    '73000000-0000-4000-8000-000000000042',
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000030',
    '73000000-0000-4000-8000-000000000013',
    'zf-durable-lemforder-validation',
    'active',
    'single_brand',
    'observation_only',
    array['product_identity']::text[],
    100,
    3,
    600,
    '{}'::jsonb,
    '{"sourceMode":"zf_aftermarket_official_only"}'::jsonb
  ),
  (
    '74000000-0000-4000-8000-000000000040',
    '74000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000020',
    '74000000-0000-4000-8000-000000000030',
    '74000000-0000-4000-8000-000000000010',
    'zf-durable-other-validation',
    'active',
    'single_brand',
    'observation_only',
    array['product_identity']::text[],
    100,
    3,
    600,
    '{}'::jsonb,
    '{"sourceMode":"zf_aftermarket_official_only"}'::jsonb
  );

insert into public.catalog_products (
  id,
  organization_id,
  brand_id,
  product_code,
  description
)
values
  (
    '73000000-0000-4000-8000-000000000050',
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000010',
    '0071315002',
    'Existing ZF Product'
  ),
  (
    '73000000-0000-4000-8000-000000000051',
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000010',
    'OTHER-001',
    'Other ZF Product'
  ),
  (
    '73000000-0000-4000-8000-000000000052',
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000012',
    '105-ENGINE-001',
    'Motorservice TRW Engine Components control'
  );

select set_config('request.jwt.claim.role', 'service_role', true);

do $zf_run_replay$
declare
  v_first jsonb;
  v_replay jsonb;
  v_conflict jsonb;
  v_run_count integer;
begin
  v_first := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-run-1',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'cursor-0',
    'zf-durable-staging.v1',
    'validation-source-revision-1'
  );

  v_replay := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-run-1',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'cursor-0',
    'zf-durable-staging.v1',
    'validation-source-revision-1'
  );

  v_conflict := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-run-1',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'different-cursor',
    'zf-durable-staging.v1',
    'validation-source-revision-1'
  );

  select count(*)::integer
  into v_run_count
  from public.catalog_observation_runs run
  where run.organization_id = '73000000-0000-4000-8000-000000000001'
    and run.idempotency_key = 'zf-validation-run-1'
    and run.contract_version = '1.0.0';

  if coalesce((v_first ->> 'replayed')::boolean, true)
     or not coalesce((v_replay ->> 'replayed')::boolean, false)
     or v_first ->> 'run_id' <> v_replay ->> 'run_id'
     or v_conflict ->> 'error_code' <> 'RUN_IDEMPOTENCY_CONFLICT'
     or v_run_count <> 1 then
    raise exception 'Run replay/conflict invariant failed: first=% replay=% conflict=% count=%',
      v_first, v_replay, v_conflict, v_run_count;
  end if;

  insert into zf_durable_gate_results values
    (
      '01_run_replay_conflict',
      'PASS',
      'same request replays one run; changed fingerprint returns RUN_IDEMPOTENCY_CONFLICT'
    );
end;
$zf_run_replay$;

do $zf_stage_candidate$
declare
  v_run_id uuid;
  v_candidate jsonb;
  v_payload_fingerprint text;
  v_observation_fingerprint text;
  v_item jsonb;
  v_first jsonb;
  v_replay jsonb;
  v_candidate_count integer;
  v_event_count integer;
  v_outcome_count integer;
  v_product_count_before integer;
  v_product_count_after integer;
begin
  select run.id
  into v_run_id
  from public.catalog_observation_runs run
  where run.organization_id = '73000000-0000-4000-8000-000000000001'
    and run.idempotency_key = 'zf-validation-run-1';

  v_candidate := jsonb_build_object(
    'proposedDisplayCode', '1234.56-7',
    'description', 'Official ZF staged fixture',
    'ean', '4000000000001',
    'hsCode', '8708.99',
    'origin', 'DE',
    'weightKg', 1.2500,
    'oemReferences', jsonb_build_array('OE-001'),
    'vehicleApplications', jsonb_build_array('Validation vehicle'),
    'fitmentFacts', jsonb_build_array(
      jsonb_build_object('type', 'vehicle', 'value', 'Validation vehicle')
    ),
    'engineFacts', jsonb_build_array('Validation engine'),
    'lifecycleStatus', 'active',
    'lifecycleNote', null,
    'replacementCandidates', '[]'::jsonb,
    'supersessionCandidates', '[]'::jsonb,
    'officialImageCandidateUrl', 'https://aftermarket.zf.com/fixture/product.jpg',
    'officialImageEvidenceReference', 'zf-validation-image-ref',
    'limitationFlags', '[]'::jsonb,
    'sourceSchemaVersion', 'validation.v1',
    'quarantineClass', null
  );

  v_payload_fingerprint := public.catalog_zf_candidate_payload_fingerprint(
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000010',
    '1234.56-7',
    '1234567',
    v_candidate,
    '1.0.0'
  );

  v_observation_fingerprint := public.catalog_zf_observation_fingerprint(
    v_payload_fingerprint,
    'validation-source-revision-1',
    '2026-07-26T12:00:00Z'::timestamptz,
    repeat('a', 64),
    'zf-validation-product-ref-1234567'
  );

  v_item := jsonb_build_object(
    'requestedDisplayCode', '1234.56-7',
    'officialBrand', 'ZF',
    'officialDisplayCode', '1234.56-7',
    'officialComparisonKey', '1234567',
    'officialSourceReference', 'zf-validation-product-ref-1234567',
    'officialSourceUrl', 'https://aftermarket.zf.com/fixture/1234567',
    'outcome', 'NEW_PRODUCT_STAGED',
    'retryable', false,
    'attemptCount', 1,
    'checkpointEligible', true,
    'checkpointCursor', 'cursor-1',
    'startedAt', '2026-07-26T11:59:59Z',
    'completedAt', '2026-07-26T12:00:01Z',
    'observedAt', '2026-07-26T12:00:00Z',
    'evidenceHash', repeat('a', 64),
    'payloadFingerprint', v_payload_fingerprint,
    'observationFingerprint', v_observation_fingerprint,
    'candidate', v_candidate
  );

  select count(*)::integer
  into v_product_count_before
  from public.catalog_products product
  where product.organization_id = '73000000-0000-4000-8000-000000000001';

  v_first := public.record_catalog_zf_durable_item(v_run_id, 1, v_item);
  v_replay := public.record_catalog_zf_durable_item(v_run_id, 1, v_item);

  select count(*)::integer
  into v_candidate_count
  from public.catalog_new_product_staging_candidates candidate
  where candidate.organization_id = '73000000-0000-4000-8000-000000000001'
    and candidate.normalized_code = '1234.56-7';

  select count(*)::integer
  into v_event_count
  from public.catalog_new_product_staging_events event
  join public.catalog_new_product_staging_candidates candidate
    on candidate.id = event.candidate_id
   and candidate.organization_id = event.organization_id
  where candidate.normalized_code = '1234.56-7';

  select count(*)::integer
  into v_outcome_count
  from public.catalog_observation_item_outcomes outcome
  where outcome.organization_id = '73000000-0000-4000-8000-000000000001'
    and outcome.run_id = v_run_id
    and outcome.sequence_no = 1;

  select count(*)::integer
  into v_product_count_after
  from public.catalog_products product
  where product.organization_id = '73000000-0000-4000-8000-000000000001';

  if coalesce((v_first ->> 'replayed')::boolean, true)
     or not coalesce((v_replay ->> 'replayed')::boolean, false)
     or v_first ->> 'staging_candidate_id' <> v_replay ->> 'staging_candidate_id'
     or v_candidate_count <> 1
     or v_event_count <> 1
     or v_outcome_count <> 1
     or v_product_count_before <> v_product_count_after then
    raise exception 'Staging/replay/no-Product invariant failed: first=% replay=% candidates=% events=% outcomes=% product_before=% product_after=%',
      v_first,
      v_replay,
      v_candidate_count,
      v_event_count,
      v_outcome_count,
      v_product_count_before,
      v_product_count_after;
  end if;

  begin
    perform public.record_catalog_zf_durable_item(
      v_run_id,
      1,
      v_item || jsonb_build_object(
        'payloadFingerprint',
        repeat('b', 64),
        'observationFingerprint',
        repeat('c', 64)
      )
    );
    raise exception 'Expected SOURCE_PAYLOAD_CONFLICT';
  exception
    when unique_violation then
      if sqlerrm <> 'SOURCE_PAYLOAD_CONFLICT' then
        raise;
      end if;
  end;

  if (
    select count(*)
    from public.catalog_observation_item_outcomes outcome
    where outcome.organization_id = '73000000-0000-4000-8000-000000000001'
      and outcome.run_id = v_run_id
      and outcome.sequence_no = 1
  ) <> 1 then
    raise exception 'SOURCE_PAYLOAD_CONFLICT changed durable item state';
  end if;

  insert into zf_durable_gate_results values
    (
      '02_candidate_stage_replay_conflict_no_apply',
      'PASS',
      'candidate staged once, exact replay is stable, changed payload conflicts, Product count unchanged'
    );
end;
$zf_stage_candidate$;

do $zf_unknown_and_redaction$
declare
  v_run_id uuid;
  v_outcomes_before integer;
  v_audit_before integer;
begin
  select run.id
  into v_run_id
  from public.catalog_observation_runs run
  where run.organization_id = '73000000-0000-4000-8000-000000000001'
    and run.idempotency_key = 'zf-validation-run-1';

  select count(*)::integer
  into v_outcomes_before
  from public.catalog_observation_item_outcomes outcome
  where outcome.run_id = v_run_id;

  select count(*)::integer
  into v_audit_before
  from public.catalog_observation_audit_ledger audit
  where audit.run_id = v_run_id;

  begin
    perform public.record_catalog_zf_durable_item(
      v_run_id,
      2,
      jsonb_build_object(
        'requestedDisplayCode', 'UNKNOWN-001',
        'outcome', 'SEARCH_RETURNED_ZERO',
        'payloadFingerprint', repeat('d', 64),
        'observationFingerprint', repeat('e', 64),
        'unexpectedField', 'must fail'
      )
    );
    raise exception 'Expected unknown-field rejection';
  exception
    when invalid_parameter_value then
      if sqlerrm not like 'UNKNOWN_ITEM_FIELD:%' then
        raise;
      end if;
  end;

  begin
    perform public.record_catalog_zf_durable_item(
      v_run_id,
      2,
      jsonb_build_object(
        'requestedDisplayCode', 'REDACTION-001',
        'outcome', 'PROVIDER_SCHEMA_CHANGED',
        'payloadFingerprint', repeat('d', 64),
        'observationFingerprint', repeat('e', 64),
        'errorSummary', 'Authorization: Bearer credential-material'
      )
    );
    raise exception 'Expected redaction rejection';
  exception
    when invalid_parameter_value then
      if sqlerrm <> 'REDACTION_UNSAFE_ITEM_PAYLOAD' then
        raise;
      end if;
  end;

  if (
    select count(*)
    from public.catalog_observation_item_outcomes outcome
    where outcome.run_id = v_run_id
  ) <> v_outcomes_before
  or (
    select count(*)
    from public.catalog_observation_audit_ledger audit
    where audit.run_id = v_run_id
  ) <> v_audit_before then
    raise exception 'Unknown/redaction failure changed boundary state';
  end if;

  insert into zf_durable_gate_results values
    (
      '03_unknown_field_and_redaction',
      'PASS',
      'unknown fields and credential-shaped text fail closed with zero state change'
    );
end;
$zf_unknown_and_redaction$;

do $zf_finish_first_run$
declare
  v_run_id uuid;
  v_finish jsonb;
  v_checkpoint jsonb;
begin
  select run.id
  into v_run_id
  from public.catalog_observation_runs run
  where run.organization_id = '73000000-0000-4000-8000-000000000001'
    and run.idempotency_key = 'zf-validation-run-1';

  v_finish := public.finish_catalog_zf_durable_run(
    v_run_id,
    'succeeded',
    null
  );
  v_checkpoint := public.advance_catalog_zf_durable_checkpoint(v_run_id);

  if v_finish ->> 'completion_class' <> 'SUCCEEDED'
     or v_checkpoint ->> 'safe_checkpoint_cursor' <> 'cursor-1' then
    raise exception 'Run finish/checkpoint failed: finish=% checkpoint=%',
      v_finish, v_checkpoint;
  end if;

  insert into zf_durable_gate_results values
    (
      '04_reconciled_finish_checkpoint',
      'PASS',
      'terminal outcome reconciles and advances only its committed safe cursor'
    );
end;
$zf_finish_first_run$;

do $zf_candidate_replay_and_version$
declare
  v_run_2 jsonb;
  v_run_3 jsonb;
  v_candidate jsonb;
  v_changed_candidate jsonb;
  v_payload text;
  v_observation text;
  v_changed_payload text;
  v_changed_observation text;
  v_result jsonb;
  v_changed_result jsonb;
  v_versions integer;
  v_version_two public.catalog_new_product_staging_candidates%rowtype;
begin
  v_run_2 := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-run-2',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'cursor-1',
    'zf-durable-staging.v1',
    'validation-source-revision-2'
  );

  v_candidate := jsonb_build_object(
    'proposedDisplayCode', '1234.56-7',
    'description', 'Official ZF staged fixture',
    'ean', '4000000000001',
    'hsCode', '8708.99',
    'origin', 'DE',
    'weightKg', 1.2500,
    'oemReferences', jsonb_build_array('OE-001'),
    'vehicleApplications', jsonb_build_array('Validation vehicle'),
    'fitmentFacts', jsonb_build_array(
      jsonb_build_object('type', 'vehicle', 'value', 'Validation vehicle')
    ),
    'engineFacts', jsonb_build_array('Validation engine'),
    'lifecycleStatus', 'active',
    'lifecycleNote', null,
    'replacementCandidates', '[]'::jsonb,
    'supersessionCandidates', '[]'::jsonb,
    'officialImageCandidateUrl', 'https://aftermarket.zf.com/fixture/product.jpg',
    'officialImageEvidenceReference', 'zf-validation-image-ref',
    'limitationFlags', '[]'::jsonb,
    'sourceSchemaVersion', 'validation.v1',
    'quarantineClass', null
  );

  v_payload := public.catalog_zf_candidate_payload_fingerprint(
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000010',
    '1234.56-7',
    '1234567',
    v_candidate,
    '1.0.0'
  );
  v_observation := public.catalog_zf_observation_fingerprint(
    v_payload,
    'validation-source-revision-2',
    '2026-07-26T13:00:00Z'::timestamptz,
    repeat('a', 64),
    'zf-validation-product-ref-1234567'
  );

  v_result := public.record_catalog_zf_durable_item(
    (v_run_2 ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', '1234.56-7',
      'officialBrand', 'ZF',
      'officialDisplayCode', '1234.56-7',
      'officialComparisonKey', '1234567',
      'officialSourceReference', 'zf-validation-product-ref-1234567',
      'officialSourceUrl', 'https://aftermarket.zf.com/fixture/1234567',
      'outcome', 'NEW_PRODUCT_STAGED',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'cursor-2',
      'startedAt', '2026-07-26T12:59:59Z',
      'completedAt', '2026-07-26T13:00:01Z',
      'observedAt', '2026-07-26T13:00:00Z',
      'evidenceHash', repeat('a', 64),
      'payloadFingerprint', v_payload,
      'observationFingerprint', v_observation,
      'candidate', v_candidate
    )
  );

  if v_result ->> 'outcome' <> 'STAGING_REPLAYED'
     or not (v_result ->> 'staging_replayed')::boolean then
    raise exception 'Unchanged later handoff did not replay candidate: %', v_result;
  end if;

  perform public.finish_catalog_zf_durable_run(
    (v_run_2 ->> 'run_id')::uuid,
    'succeeded',
    null
  );

  v_run_3 := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-run-3',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'cursor-2',
    'zf-durable-staging.v1',
    'validation-source-revision-3'
  );

  v_changed_candidate := v_candidate || jsonb_build_object(
    'description',
    'Official ZF staged fixture changed'
  );
  v_changed_payload := public.catalog_zf_candidate_payload_fingerprint(
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000010',
    '1234.56-7',
    '1234567',
    v_changed_candidate,
    '1.0.0'
  );
  v_changed_observation := public.catalog_zf_observation_fingerprint(
    v_changed_payload,
    'validation-source-revision-3',
    '2026-07-26T14:00:00Z'::timestamptz,
    repeat('f', 64),
    'zf-validation-product-ref-1234567'
  );

  v_changed_result := public.record_catalog_zf_durable_item(
    (v_run_3 ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', '1234.56-7',
      'officialBrand', 'ZF',
      'officialDisplayCode', '1234.56-7',
      'officialComparisonKey', '1234567',
      'officialSourceReference', 'zf-validation-product-ref-1234567',
      'officialSourceUrl', 'https://aftermarket.zf.com/fixture/1234567',
      'outcome', 'NEW_PRODUCT_STAGED',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'cursor-3',
      'startedAt', '2026-07-26T13:59:59Z',
      'completedAt', '2026-07-26T14:00:01Z',
      'observedAt', '2026-07-26T14:00:00Z',
      'evidenceHash', repeat('f', 64),
      'payloadFingerprint', v_changed_payload,
      'observationFingerprint', v_changed_observation,
      'candidate', v_changed_candidate
    )
  );

  select count(*)::integer
  into v_versions
  from public.catalog_new_product_staging_candidates candidate
  where candidate.organization_id = '73000000-0000-4000-8000-000000000001'
    and candidate.brand_id = '73000000-0000-4000-8000-000000000010'
    and candidate.normalized_code = '1234.56-7';

  select *
  into v_version_two
  from public.catalog_new_product_staging_candidates candidate
  where candidate.id = (v_changed_result ->> 'staging_candidate_id')::uuid;

  if v_versions <> 2
     or v_version_two.candidate_version <> 2
     or v_version_two.supersedes_candidate_id is null then
    raise exception 'Candidate versioning failed: versions=% row=%',
      v_versions, row_to_json(v_version_two);
  end if;

  perform public.finish_catalog_zf_durable_run(
    (v_run_3 ->> 'run_id')::uuid,
    'succeeded',
    null
  );

  insert into zf_durable_gate_results values
    (
      '05_candidate_replay_and_versioning',
      'PASS',
      'unchanged payload reuses immutable candidate; changed payload creates linked version 2'
    );
end;
$zf_candidate_replay_and_version$;

do $zf_alias_and_conflict$
declare
  v_run_alias jsonb;
  v_run_conflict jsonb;
  v_alias_result jsonb;
  v_conflict_result jsonb;
  v_alias_count integer;
  v_product_codes text[];
begin
  v_run_alias := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-alias-run',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'alias-cursor-0',
    'zf-durable-staging.v1',
    'validation-source-revision-alias'
  );

  v_alias_result := public.record_catalog_zf_durable_item(
    (v_run_alias ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', '0071315002',
      'officialBrand', 'ZF',
      'officialDisplayCode', '0071.315.002',
      'officialComparisonKey', '0071315002',
      'officialSourceReference', 'zf-validation-alias-ref',
      'officialSourceUrl', 'https://aftermarket.zf.com/fixture/0071315002',
      'outcome', 'OFFICIAL_DISPLAY_ALIAS_RECORDED',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'alias-cursor-1',
      'startedAt', '2026-07-26T15:00:00Z',
      'completedAt', '2026-07-26T15:00:01Z',
      'observedAt', '2026-07-26T15:00:00Z',
      'evidenceHash', repeat('1', 64),
      'payloadFingerprint', repeat('2', 64),
      'observationFingerprint', repeat('3', 64),
      'existingCatalogProductId', '73000000-0000-4000-8000-000000000050'
    )
  );

  perform public.finish_catalog_zf_durable_run(
    (v_run_alias ->> 'run_id')::uuid,
    'succeeded',
    null
  );

  v_run_conflict := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-alias-conflict-run',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'alias-cursor-1',
    'zf-durable-staging.v1',
    'validation-source-revision-alias-conflict'
  );

  v_conflict_result := public.record_catalog_zf_durable_item(
    (v_run_conflict ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', 'OTHER-001',
      'officialBrand', 'ZF',
      'officialDisplayCode', '0071.315.002',
      'officialComparisonKey', 'OTHER001',
      'officialSourceReference', 'zf-validation-alias-conflict-ref',
      'officialSourceUrl', 'https://aftermarket.zf.com/fixture/0071315002',
      'outcome', 'OFFICIAL_DISPLAY_ALIAS_RECORDED',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'alias-cursor-2',
      'startedAt', '2026-07-26T15:01:00Z',
      'completedAt', '2026-07-26T15:01:01Z',
      'observedAt', '2026-07-26T15:01:00Z',
      'evidenceHash', repeat('4', 64),
      'payloadFingerprint', repeat('5', 64),
      'observationFingerprint', repeat('6', 64),
      'existingCatalogProductId', '73000000-0000-4000-8000-000000000051'
    )
  );

  select count(*)::integer
  into v_alias_count
  from public.catalog_product_source_aliases alias
  where alias.organization_id = '73000000-0000-4000-8000-000000000001'
    and alias.official_source_display_code = '0071.315.002';

  select array_agg(product.product_code order by product.id)
  into v_product_codes
  from public.catalog_products product
  where product.id in (
    '73000000-0000-4000-8000-000000000050',
    '73000000-0000-4000-8000-000000000051'
  );

  if v_alias_result ->> 'outcome' <> 'OFFICIAL_DISPLAY_ALIAS_RECORDED'
     or v_conflict_result ->> 'outcome' <> 'SOURCE_ALIAS_CONFLICT'
     or v_alias_count <> 1
     or v_product_codes <> array['0071315002', 'OTHER-001']::text[] then
    raise exception 'Alias/conflict/no-rewrite invariant failed: alias=% conflict=% count=% codes=%',
      v_alias_result, v_conflict_result, v_alias_count, v_product_codes;
  end if;

  perform public.finish_catalog_zf_durable_run(
    (v_run_conflict ->> 'run_id')::uuid,
    'succeeded',
    null
  );

  insert into zf_durable_gate_results values
    (
      '06_official_alias_conflict_no_rewrite',
      'PASS',
      'dotted official identity is immutable alias; conflicting mapping records conflict without Product rewrite'
    );
end;
$zf_alias_and_conflict$;

do $zf_brand_boundaries$
declare
  v_trw_run jsonb;
  v_lemforder_run jsonb;
  v_trw_result jsonb;
  v_lemforder_result jsonb;
  v_engine_product_count integer;
begin
  v_trw_run := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000041',
    'zf-validation-trw-boundary-run',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    null,
    'zf-durable-staging.v1',
    'validation-trw-boundary'
  );

  v_trw_result := public.record_catalog_zf_durable_item(
    (v_trw_run ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', '105-TRW-001',
      'officialBrand', 'TRW',
      'officialDisplayCode', '105-TRW-001',
      'officialComparisonKey', '105TRW001',
      'officialSourceReference', 'zf-validation-trw-boundary-ref',
      'officialSourceUrl', 'https://aftermarket.zf.com/fixture/105TRW001',
      'outcome', 'SUSPECT_PROVIDER_BOUNDARY',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'trw-boundary-1',
      'startedAt', '2026-07-26T16:00:00Z',
      'completedAt', '2026-07-26T16:00:01Z',
      'observedAt', '2026-07-26T16:00:00Z',
      'evidenceHash', repeat('7', 64),
      'payloadFingerprint', repeat('8', 64),
      'observationFingerprint', repeat('9', 64),
      'errorCode', 'SUSPECT_PROVIDER_BOUNDARY',
      'errorSummary', 'ZF TRW candidate overlaps protected engine-component pattern'
    )
  );

  perform public.finish_catalog_zf_durable_run(
    (v_trw_run ->> 'run_id')::uuid,
    'completed_with_warnings',
    null
  );

  v_lemforder_run := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000042',
    'zf-validation-lemforder-boundary-run',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    null,
    'zf-durable-staging.v1',
    'validation-lemforder-boundary'
  );

  v_lemforder_result := public.record_catalog_zf_durable_item(
    (v_lemforder_run ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', 'LEM-001',
      'officialBrand', 'Sachs',
      'officialDisplayCode', 'SACHS-001',
      'officialComparisonKey', 'SACHS001',
      'officialSourceReference', 'zf-validation-wrong-brand-ref',
      'officialSourceUrl', 'https://aftermarket.zf.com/fixture/SACHS001',
      'outcome', 'OFFICIAL_BRAND_MISMATCH',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'lemforder-boundary-1',
      'startedAt', '2026-07-26T16:01:00Z',
      'completedAt', '2026-07-26T16:01:01Z',
      'observedAt', '2026-07-26T16:01:00Z',
      'evidenceHash', repeat('a', 64),
      'payloadFingerprint', repeat('b', 64),
      'observationFingerprint', repeat('c', 64),
      'errorCode', 'OFFICIAL_BRAND_MISMATCH',
      'errorSummary', 'Official response brand differs from requested Lemforder identity'
    )
  );

  perform public.finish_catalog_zf_durable_run(
    (v_lemforder_run ->> 'run_id')::uuid,
    'completed_with_warnings',
    null
  );

  select count(*)::integer
  into v_engine_product_count
  from public.catalog_products product
  where product.id = '73000000-0000-4000-8000-000000000052'
    and product.brand_id = '73000000-0000-4000-8000-000000000012'
    and product.product_code = '105-ENGINE-001';

  if v_trw_result ->> 'outcome' <> 'SUSPECT_PROVIDER_BOUNDARY'
     or v_lemforder_result ->> 'outcome' <> 'OFFICIAL_BRAND_MISMATCH'
     or v_engine_product_count <> 1
     or exists (
       select 1
       from public.catalog_new_product_staging_candidates candidate
       where candidate.run_id in (
         (v_trw_run ->> 'run_id')::uuid,
         (v_lemforder_run ->> 'run_id')::uuid
       )
     ) then
    raise exception 'Brand boundary quarantine failed: trw=% lemforder=% engine_count=%',
      v_trw_result, v_lemforder_result, v_engine_product_count;
  end if;

  insert into zf_durable_gate_results values
    (
      '07_brand_and_motorservice_boundary',
      'PASS',
      'TRW 105 pattern and Lemforder wrong-brand evidence quarantine; TRW Engine Components remains untouched'
    );
end;
$zf_brand_boundaries$;

do $zf_checkpoint_and_timeout$
declare
  v_run jsonb;
  v_timeout_run jsonb;
  v_result jsonb;
  v_run_row public.catalog_observation_runs%rowtype;
begin
  v_run := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-contiguous-run',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'contiguous-0',
    'zf-durable-staging.v1',
    'validation-contiguous'
  );

  perform public.record_catalog_zf_durable_item(
    (v_run ->> 'run_id')::uuid,
    2,
    jsonb_build_object(
      'requestedDisplayCode', 'ZERO-002',
      'outcome', 'SEARCH_RETURNED_ZERO',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'contiguous-2',
      'startedAt', '2026-07-26T17:00:00Z',
      'completedAt', '2026-07-26T17:00:01Z',
      'payloadFingerprint', repeat('d', 64),
      'observationFingerprint', repeat('e', 64)
    )
  );

  select *
  into v_run_row
  from public.catalog_observation_runs run
  where run.id = (v_run ->> 'run_id')::uuid;

  if v_run_row.safe_checkpoint_cursor is not null then
    raise exception 'Checkpoint advanced across missing sequence 1';
  end if;

  perform public.record_catalog_zf_durable_item(
    (v_run ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', 'ZERO-001',
      'outcome', 'SEARCH_RETURNED_ZERO',
      'retryable', false,
      'attemptCount', 1,
      'checkpointEligible', true,
      'checkpointCursor', 'contiguous-1',
      'startedAt', '2026-07-26T17:00:00Z',
      'completedAt', '2026-07-26T17:00:01Z',
      'payloadFingerprint', repeat('f', 64),
      'observationFingerprint', repeat('0', 64)
    )
  );

  select *
  into v_run_row
  from public.catalog_observation_runs run
  where run.id = (v_run ->> 'run_id')::uuid;

  if v_run_row.safe_checkpoint_cursor <> 'contiguous-2' then
    raise exception 'Contiguous checkpoint did not advance to sequence 2: %',
      v_run_row.safe_checkpoint_cursor;
  end if;

  perform public.finish_catalog_zf_durable_run(
    (v_run ->> 'run_id')::uuid,
    'succeeded',
    null
  );

  v_timeout_run := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-timeout-run',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    'timeout-0',
    'zf-durable-staging.v1',
    'validation-timeout'
  );

  perform public.record_catalog_zf_durable_item(
    (v_timeout_run ->> 'run_id')::uuid,
    1,
    jsonb_build_object(
      'requestedDisplayCode', 'TIMEOUT-001',
      'outcome', 'PROVIDER_TIMEOUT',
      'retryable', true,
      'attemptCount', 1,
      'checkpointEligible', false,
      'startedAt', '2026-07-26T17:01:00Z',
      'completedAt', '2026-07-26T17:01:01Z',
      'payloadFingerprint', repeat('1', 64),
      'observationFingerprint', repeat('2', 64),
      'errorCode', 'PROVIDER_TIMEOUT',
      'errorSummary', 'Bounded provider timeout'
    )
  );

  begin
    perform public.finish_catalog_zf_durable_run(
      (v_timeout_run ->> 'run_id')::uuid,
      'succeeded',
      null
    );
    raise exception 'Expected timeout reconciliation failure';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm <> 'ZF_RUN_OUTCOMES_NOT_RECONCILED' then
        raise;
      end if;
  end;

  v_result := public.finish_catalog_zf_durable_run(
    (v_timeout_run ->> 'run_id')::uuid,
    'failed',
    'Bounded provider timeout'
  );

  begin
    perform public.advance_catalog_zf_durable_checkpoint(
      (v_timeout_run ->> 'run_id')::uuid
    );
    raise exception 'Expected failed-run checkpoint rejection';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm <> 'ZF_CHECKPOINT_REQUIRES_RECONCILED_TERMINAL_RUN' then
        raise;
      end if;
  end;

  if v_result ->> 'completion_class' <> 'FAILED' then
    raise exception 'Timeout run did not fail closed: %', v_result;
  end if;

  insert into zf_durable_gate_results values
    (
      '08_contiguous_checkpoint_timeout',
      'PASS',
      'missing sequence blocks cursor; contiguous outcomes advance; timeout cannot finish successful or checkpoint'
    );
end;
$zf_checkpoint_and_timeout$;

create or replace function public.nm_catalog_zf_atomic_failure_probe()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.requested_display_code = 'ATOMIC-FAIL-001' then
    raise exception using errcode = 'P0001', message = 'ATOMIC_FAILURE_PROBE';
  end if;
  return new;
end;
$$;

create trigger trg_nm_catalog_zf_atomic_failure_probe
before insert on public.catalog_observation_item_outcomes
for each row execute function public.nm_catalog_zf_atomic_failure_probe();

do $zf_atomicity$
declare
  v_run jsonb;
  v_candidate jsonb;
  v_payload text;
  v_observation text;
  v_candidate_count_before integer;
  v_event_count_before integer;
  v_outcome_count_before integer;
  v_audit_count_before integer;
begin
  v_run := public.begin_catalog_zf_durable_run(
    '73000000-0000-4000-8000-000000000040',
    'zf-validation-atomic-run',
    '5b7ee1873285ad88f5342126ca965ee8d9021b06',
    'local-non-production',
    1,
    null,
    'zf-durable-staging.v1',
    'validation-atomic'
  );

  v_candidate := jsonb_build_object(
    'proposedDisplayCode', 'ATOMIC-FAIL-001',
    'description', 'Atomic failure fixture',
    'ean', null,
    'hsCode', null,
    'origin', null,
    'weightKg', null,
    'oemReferences', '[]'::jsonb,
    'vehicleApplications', '[]'::jsonb,
    'fitmentFacts', '[]'::jsonb,
    'engineFacts', '[]'::jsonb,
    'lifecycleStatus', 'unknown',
    'lifecycleNote', null,
    'replacementCandidates', '[]'::jsonb,
    'supersessionCandidates', '[]'::jsonb,
    'officialImageCandidateUrl', null,
    'officialImageEvidenceReference', null,
    'limitationFlags', jsonb_build_array('VALIDATION_FIXTURE'),
    'sourceSchemaVersion', 'validation.v1',
    'quarantineClass', null
  );

  v_payload := public.catalog_zf_candidate_payload_fingerprint(
    '73000000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000020',
    '73000000-0000-4000-8000-000000000010',
    'ATOMIC-FAIL-001',
    'ATOMICFAIL001',
    v_candidate,
    '1.0.0'
  );
  v_observation := public.catalog_zf_observation_fingerprint(
    v_payload,
    'validation-atomic',
    '2026-07-26T18:00:00Z'::timestamptz,
    repeat('3', 64),
    'zf-validation-atomic-ref'
  );

  select count(*) into v_candidate_count_before
  from public.catalog_new_product_staging_candidates;
  select count(*) into v_event_count_before
  from public.catalog_new_product_staging_events;
  select count(*) into v_outcome_count_before
  from public.catalog_observation_item_outcomes;
  select count(*) into v_audit_count_before
  from public.catalog_observation_audit_ledger;

  begin
    perform public.record_catalog_zf_durable_item(
      (v_run ->> 'run_id')::uuid,
      1,
      jsonb_build_object(
        'requestedDisplayCode', 'ATOMIC-FAIL-001',
        'officialBrand', 'ZF',
        'officialDisplayCode', 'ATOMIC-FAIL-001',
        'officialComparisonKey', 'ATOMICFAIL001',
        'officialSourceReference', 'zf-validation-atomic-ref',
        'officialSourceUrl', 'https://aftermarket.zf.com/fixture/atomic-fail',
        'outcome', 'NEW_PRODUCT_STAGED',
        'retryable', false,
        'attemptCount', 1,
        'checkpointEligible', true,
        'checkpointCursor', 'atomic-1',
        'startedAt', '2026-07-26T17:59:59Z',
        'completedAt', '2026-07-26T18:00:01Z',
        'observedAt', '2026-07-26T18:00:00Z',
        'evidenceHash', repeat('3', 64),
        'payloadFingerprint', v_payload,
        'observationFingerprint', v_observation,
        'candidate', v_candidate
      )
    );
    raise exception 'Expected atomic failure probe';
  exception
    when raise_exception then
      if sqlerrm <> 'ATOMIC_FAILURE_PROBE' then
        raise;
      end if;
  end;

  if (select count(*) from public.catalog_new_product_staging_candidates)
       <> v_candidate_count_before
     or (select count(*) from public.catalog_new_product_staging_events)
       <> v_event_count_before
     or (select count(*) from public.catalog_observation_item_outcomes)
       <> v_outcome_count_before
     or (select count(*) from public.catalog_observation_audit_ledger)
       <> v_audit_count_before then
    raise exception 'Injected item failure left partial durable state';
  end if;

  perform public.finish_catalog_zf_durable_run(
    (v_run ->> 'run_id')::uuid,
    'cancelled',
    null
  );

  insert into zf_durable_gate_results values
    (
      '09_atomic_failure',
      'PASS',
      'injected post-staging failure rolls back candidate, event, outcome, and audit atomically'
    );
end;
$zf_atomicity$;

drop trigger trg_nm_catalog_zf_atomic_failure_probe
  on public.catalog_observation_item_outcomes;
drop function public.nm_catalog_zf_atomic_failure_probe();

do $zf_append_only$
declare
  v_candidate_id uuid;
  v_alias_id uuid;
  v_outcome_id uuid;
  v_event_id uuid;
begin
  select id into v_candidate_id
  from public.catalog_new_product_staging_candidates
  order by created_at, id
  limit 1;
  select id into v_alias_id
  from public.catalog_product_source_aliases
  order by created_at, id
  limit 1;
  select id into v_outcome_id
  from public.catalog_observation_item_outcomes
  order by persisted_at, id
  limit 1;
  select id into v_event_id
  from public.catalog_new_product_staging_events
  order by created_at, id
  limit 1;

  begin
    update public.catalog_new_product_staging_candidates
    set description = 'mutated'
    where id = v_candidate_id;
    raise exception 'Expected immutable candidate rejection';
  exception
    when object_not_in_prerequisite_state then null;
  end;

  begin
    delete from public.catalog_product_source_aliases where id = v_alias_id;
    raise exception 'Expected immutable alias rejection';
  exception
    when object_not_in_prerequisite_state then null;
  end;

  begin
    update public.catalog_observation_item_outcomes
    set error_summary = 'mutated'
    where id = v_outcome_id;
    raise exception 'Expected immutable outcome rejection';
  exception
    when object_not_in_prerequisite_state then null;
  end;

  begin
    delete from public.catalog_new_product_staging_events where id = v_event_id;
    raise exception 'Expected immutable event rejection';
  exception
    when object_not_in_prerequisite_state then null;
  end;

  insert into zf_durable_gate_results values
    (
      '10_append_only',
      'PASS',
      'candidate, alias, item outcome, and lifecycle event UPDATE/DELETE fail'
    );
end;
$zf_append_only$;

select set_config(
  'request.jwt.claim.sub',
  '73000000-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

do $zf_rls_tenant_one$
declare
  v_visible_orgs integer;
begin
  select count(distinct organization_id)::integer
  into v_visible_orgs
  from public.catalog_zf_new_product_staging_review_v;

  if v_visible_orgs <> 1
     or exists (
       select 1
       from public.catalog_zf_new_product_staging_review_v
       where organization_id <> '73000000-0000-4000-8000-000000000001'
     ) then
    raise exception 'Tenant-one RLS leaked a staging candidate';
  end if;

  begin
    perform public.begin_catalog_zf_durable_run(
      '73000000-0000-4000-8000-000000000040',
      'unauthorized-function-call',
      '5b7ee1873285ad88f5342126ca965ee8d9021b06',
      null,
      1,
      null,
      'zf-durable-staging.v1',
      null
    );
    raise exception 'Expected authenticated function execute rejection';
  exception
    when insufficient_privilege then null;
  end;
end;
$zf_rls_tenant_one$;

reset role;

insert into zf_durable_gate_results values
  (
    '11_tenant_rls_and_function_auth',
    'PASS',
    'authenticated superadmin sees one tenant only and cannot execute persistence functions'
  );

set local role service_role;

do $zf_direct_write_denied$
begin
  begin
    insert into public.catalog_observation_item_outcomes (
      organization_id,
      run_id,
      job_id,
      source_id,
      brand_id,
      sequence_no,
      requested_display_code,
      requested_normalized_code,
      outcome_class,
      observation_fingerprint,
      payload_fingerprint,
      contract_version,
      runtime_commit,
      redaction_profile_version,
      started_at,
      completed_at
    ) values (
      '73000000-0000-4000-8000-000000000001',
      gen_random_uuid(),
      '73000000-0000-4000-8000-000000000040',
      '73000000-0000-4000-8000-000000000020',
      '73000000-0000-4000-8000-000000000010',
      99,
      'DIRECT-WRITE',
      'DIRECT-WRITE',
      'CANCELLED',
      repeat('a', 64),
      repeat('b', 64),
      '1.0.0',
      '5b7ee1873285ad88f5342126ca965ee8d9021b06',
      'catalog-source-evidence-redaction.v1',
      now(),
      now()
    );
    raise exception 'Expected service-role direct write rejection';
  exception
    when insufficient_privilege then null;
  end;
end;
$zf_direct_write_denied$;

reset role;

insert into zf_durable_gate_results values
  (
    '12_service_role_execute_only',
    'PASS',
    'service_role has exact function execute but no direct staging/evidence table write'
  );

set local role anon;

do $zf_anon_denied$
begin
  begin
    perform 1 from public.catalog_new_product_staging_candidates limit 1;
    raise exception 'Expected anon read rejection';
  exception
    when insufficient_privilege then null;
  end;
end;
$zf_anon_denied$;

reset role;

insert into zf_durable_gate_results values
  (
    '13_anon_denied',
    'PASS',
    'anon cannot read durable staging or evidence tables'
  );

do $zf_no_apply_and_reserved_events$
declare
  v_reserved_count integer;
begin
  select count(*)::integer
  into v_reserved_count
  from public.catalog_new_product_staging_events event
  where event.event_type in (
    'ACCEPTED_FOR_PRODUCT_CREATION',
    'APPLY_REQUESTED',
    'APPLIED',
    'APPLY_FAILED'
  );

  if v_reserved_count <> 0
     or (
       select count(*)
       from public.catalog_products product
       where product.organization_id = '73000000-0000-4000-8000-000000000001'
     ) <> 3
     or exists (
       select 1
       from public.catalog_apply_events apply_event
       where apply_event.organization_id = '73000000-0000-4000-8000-000000000001'
     )
     or exists (
       select 1
       from public.catalog_observation_review_decisions decision
       where decision.organization_id = '73000000-0000-4000-8000-000000000001'
     ) then
    raise exception 'No-Apply boundary changed Product/review/Apply state';
  end if;

  insert into zf_durable_gate_results values
    (
      '14_no_apply',
      'PASS',
      'no Product, review, Guardian, relation, image authority, or Apply event is created'
    );
end;
$zf_no_apply_and_reserved_events$;

set local enable_seqscan = off;

do $zf_query_plans$
declare
  v_plan text := '';
  v_plan_line text;
begin
  for v_plan_line in execute $plan$
    explain (format text)
    select run.id
    from public.catalog_observation_runs run
    where run.organization_id = '73000000-0000-4000-8000-000000000001'
      and run.idempotency_key = 'zf-validation-run-1'
      and run.contract_version = '1.0.0'
  $plan$
  loop
    v_plan := v_plan || E'\n' || v_plan_line;
  end loop;

  if v_plan like '%Seq Scan on catalog_observation_runs%' then
    raise exception 'Run replay plan is unbounded: %', v_plan;
  end if;

  v_plan := '';
  for v_plan_line in execute $plan$
    explain (format text)
    select outcome.id
    from public.catalog_observation_item_outcomes outcome
    where outcome.organization_id = '73000000-0000-4000-8000-000000000001'
      and outcome.run_id = (
        select run.id
        from public.catalog_observation_runs run
        where run.organization_id = '73000000-0000-4000-8000-000000000001'
          and run.idempotency_key = 'zf-validation-run-1'
          and run.contract_version = '1.0.0'
      )
    order by outcome.sequence_no
    limit 50
  $plan$
  loop
    v_plan := v_plan || E'\n' || v_plan_line;
  end loop;

  if v_plan like '%Seq Scan on catalog_observation_item_outcomes%' then
    raise exception 'Item page plan is unbounded: %', v_plan;
  end if;

  v_plan := '';
  for v_plan_line in execute $plan$
    explain (format text)
    select candidate.id
    from public.catalog_new_product_staging_candidates candidate
    where candidate.organization_id = '73000000-0000-4000-8000-000000000001'
      and candidate.brand_id = '73000000-0000-4000-8000-000000000010'
      and candidate.normalized_code = '1234.56-7'
    order by candidate.created_at desc
    limit 20
  $plan$
  loop
    v_plan := v_plan || E'\n' || v_plan_line;
  end loop;

  if v_plan like '%Seq Scan on catalog_new_product_staging_candidates%' then
    raise exception 'Staging duplicate plan is unbounded: %', v_plan;
  end if;

  insert into zf_durable_gate_results values
    (
      '15_bounded_query_plans',
      'PASS',
      'non-production run replay, item page, and tenant/brand staging plans avoid sequential scans'
    );
end;
$zf_query_plans$;

reset enable_seqscan;

select gate, status, detail
from zf_durable_gate_results
order by gate;

rollback;
