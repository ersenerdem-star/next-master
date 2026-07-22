begin transaction read only;

set local statement_timeout = '10min';
set local lock_timeout = '10s';

with
target_function as (
  select
    p.oid,
    p.proname,
    pg_get_function_identity_arguments(p.oid) as identity_args,
    pg_get_function_result(p.oid) as return_type,
    p.prosecdef,
    coalesce(array_to_string(p.proconfig, ','), '') as proconfig,
    pg_get_functiondef(p.oid) as function_definition,
    has_function_privilege('anon', p.oid, 'execute') as anon_exec,
    has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
    has_function_privilege('service_role', p.oid, 'execute') as service_role_exec,
    exists (
      select 1
      from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      where acl.grantee = 0
        and acl.privilege_type = 'EXECUTE'
    ) as public_exec_acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'reverse_catalog_observation_review_decision'
),
gate_results as (
  select
    'function_identity' as gate,
    case when exists (
      select 1
      from target_function
      where identity_args = 'input_review_item_id text, input_reversal_target_event_id uuid, input_reason_code text, input_reviewer_note text, input_expected_decision_version integer, input_idempotency_key text'
        and return_type = 'jsonb'
    ) then 'PASS' else 'FAIL' end as status,
    'exact reversal RPC identity arguments and jsonb return type' as detail

  union all
  select
    'security_contract',
    case when exists (
      select 1
      from target_function
      where prosecdef
        and proconfig like '%search_path=public%'
    ) then 'PASS' else 'FAIL' end,
    'SECURITY DEFINER with pinned search_path=public'

  union all
  select
    'acl_matrix',
    case when exists (
      select 1
      from target_function
      where not public_exec_acl
        and not anon_exec
        and authenticated_exec
        and service_role_exec
    ) then 'PASS' else 'FAIL' end,
    'PUBLIC/anon denied, authenticated/service_role granted as migration contract'

  union all
  select
    'auth_profile_org_scope',
    case when exists (
      select 1
      from target_function
      where function_definition like '%auth.uid()%'
        and function_definition like '%public.current_profile_org_id()%'
        and function_definition like '%from public.profiles p%'
        and function_definition like '%p.id = v_actor_id%'
        and function_definition like '%p.organization_id = v_org_id%'
        and function_definition like '%coalesce(p.is_active, true)%'
        and function_definition like '%lower(coalesce(p.role, '''')) in (''admin'', ''superadmin'')%'
    ) then 'PASS' else 'FAIL' end,
    'authenticated caller, active admin/superadmin profile and trusted organization are enforced'

  union all
  select
    'target_decision_scope',
    case when exists (
      select 1
      from target_function
      where function_definition like '%where e.event_id = input_reversal_target_event_id%'
        and function_definition like '%and e.organization_id = v_org_id%'
        and function_definition like '%and e.review_item_id = input_review_item_id%'
        and function_definition like '%v_target.event_type <> ''DECISION_RECORDED''%'
    ) then 'PASS' else 'FAIL' end,
    'target decision must belong to caller organization and review item and must be a recorded decision'

  union all
  select
    'idempotency_before_version_conflict',
    case when exists (
      select 1
      from target_function
      where position('select * into v_existing' in function_definition) > 0
        and position('v_current_version := public.catalog_review_current_version' in function_definition) > 0
        and position('select * into v_existing' in function_definition) < position('v_current_version := public.catalog_review_current_version' in function_definition)
    ) then 'PASS' else 'FAIL' end,
    'existing idempotency event lookup occurs before expected-version conflict evaluation'

  union all
  select
    'idempotency_payload_and_replay_branch',
    case when exists (
      select 1
      from target_function
      where function_definition like '%v_existing.idempotency_payload_hash <> v_payload_hash%'
        and function_definition like '%CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH%'
        and function_definition like '%''event'', to_jsonb(v_existing)%'
        and function_definition like '%''idempotency_replay'', true%'
        and position('''idempotency_replay'', true' in function_definition) < position('v_current_version := public.catalog_review_current_version' in function_definition)
    ) then 'PASS' else 'FAIL' end,
    'payload mismatch is retained and exact replay returns before mutation/version conflict'

  union all
  select
    'new_command_conflict_and_transition_checks',
    case when exists (
      select 1
      from target_function
      where function_definition like '%if v_current_version <> input_expected_decision_version then%'
        and function_definition like '%CATALOG_REVIEW_DECISION_CONFLICT%'
        and function_definition like '%if v_target.resulting_decision_version <> v_current_version then%'
        and function_definition like '%only current decision can be reversed%'
    ) then 'PASS' else 'FAIL' end,
    'stale-version and current-target checks remain for genuinely new reversal commands'

  union all
  select
    'single_append_only_insert_path',
    case when exists (
      select 1
      from target_function
      where (length(lower(function_definition)) - length(replace(lower(function_definition), 'insert into public.catalog_observation_review_decision_events', ''))) / length('insert into public.catalog_observation_review_decision_events') = 1
        and function_definition like '%''DECISION_REVERSED''%'
        and function_definition like '%array[''DECISION_REVERSED'']::text[]%'
    ) then 'PASS' else 'FAIL' end,
    'one append-only ledger insert path exists for new reversal events'

  union all
  select
    'no_canonical_or_apply_mutation',
    case when exists (
      select 1
      from target_function
      where function_definition !~* (format('%s\\s+%s\\s+public\\.catalog_products', 'insert', 'into'))
        and function_definition !~* (format('%s\\s+public\\.catalog_products', 'update'))
        and function_definition !~* (format('%s\\s+%s\\s+public\\.catalog_products', 'delete', 'from'))
        and function_definition !~* (format('%s\\s+public\\.catalog_external_observations', 'update'))
        and function_definition !~* (format('%s\\s+%s\\s+public\\.catalog_external_observations', 'delete', 'from'))
        and function_definition !~* (format('%s\\s+public\\.catalog_observation_candidates', 'update'))
        and function_definition !~* 'record_catalog_observation_apply_event'
    ) then 'PASS' else 'FAIL' end,
    'no Product, observation, recommendation, candidate or Apply mutation path exists'
)
select gate, status, detail
from gate_results
order by gate;

do $wp2f1_reversal_post_migration_gate$
declare
  v_failed_gate text;
begin
  with
  target_function as (
    select
      p.oid,
      pg_get_function_identity_arguments(p.oid) as identity_args,
      pg_get_function_result(p.oid) as return_type,
      p.prosecdef,
      coalesce(array_to_string(p.proconfig, ','), '') as proconfig,
      pg_get_functiondef(p.oid) as function_definition,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
      has_function_privilege('service_role', p.oid, 'execute') as service_role_exec,
      exists (
        select 1
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
        where acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      ) as public_exec_acl
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'reverse_catalog_observation_review_decision'
  ),
  gate_results as (
    select 'function_identity' as gate,
      case when exists (
        select 1 from target_function
        where identity_args = 'input_review_item_id text, input_reversal_target_event_id uuid, input_reason_code text, input_reviewer_note text, input_expected_decision_version integer, input_idempotency_key text'
          and return_type = 'jsonb'
      ) then 'PASS' else 'FAIL' end as status
    union all
    select 'security_contract',
      case when exists (select 1 from target_function where prosecdef and proconfig like '%search_path=public%') then 'PASS' else 'FAIL' end
    union all
    select 'acl_matrix',
      case when exists (select 1 from target_function where not public_exec_acl and not anon_exec and authenticated_exec and service_role_exec) then 'PASS' else 'FAIL' end
    union all
    select 'auth_profile_org_scope',
      case when exists (
        select 1 from target_function
        where function_definition like '%auth.uid()%'
          and function_definition like '%public.current_profile_org_id()%'
          and function_definition like '%from public.profiles p%'
          and function_definition like '%p.id = v_actor_id%'
          and function_definition like '%p.organization_id = v_org_id%'
          and function_definition like '%coalesce(p.is_active, true)%'
          and function_definition like '%lower(coalesce(p.role, '''')) in (''admin'', ''superadmin'')%'
      ) then 'PASS' else 'FAIL' end
    union all
    select 'target_decision_scope',
      case when exists (
        select 1 from target_function
        where function_definition like '%where e.event_id = input_reversal_target_event_id%'
          and function_definition like '%and e.organization_id = v_org_id%'
          and function_definition like '%and e.review_item_id = input_review_item_id%'
          and function_definition like '%v_target.event_type <> ''DECISION_RECORDED''%'
      ) then 'PASS' else 'FAIL' end
    union all
    select 'idempotency_before_version_conflict',
      case when exists (
        select 1 from target_function
        where position('select * into v_existing' in function_definition) > 0
          and position('v_current_version := public.catalog_review_current_version' in function_definition) > 0
          and position('select * into v_existing' in function_definition) < position('v_current_version := public.catalog_review_current_version' in function_definition)
      ) then 'PASS' else 'FAIL' end
    union all
    select 'idempotency_payload_and_replay_branch',
      case when exists (
        select 1 from target_function
        where function_definition like '%v_existing.idempotency_payload_hash <> v_payload_hash%'
          and function_definition like '%CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH%'
          and function_definition like '%''event'', to_jsonb(v_existing)%'
          and function_definition like '%''idempotency_replay'', true%'
          and position('''idempotency_replay'', true' in function_definition) < position('v_current_version := public.catalog_review_current_version' in function_definition)
      ) then 'PASS' else 'FAIL' end
    union all
    select 'new_command_conflict_and_transition_checks',
      case when exists (
        select 1 from target_function
        where function_definition like '%if v_current_version <> input_expected_decision_version then%'
          and function_definition like '%CATALOG_REVIEW_DECISION_CONFLICT%'
          and function_definition like '%if v_target.resulting_decision_version <> v_current_version then%'
          and function_definition like '%only current decision can be reversed%'
      ) then 'PASS' else 'FAIL' end
    union all
    select 'single_append_only_insert_path',
      case when exists (
        select 1 from target_function
        where (length(lower(function_definition)) - length(replace(lower(function_definition), 'insert into public.catalog_observation_review_decision_events', ''))) / length('insert into public.catalog_observation_review_decision_events') = 1
          and function_definition like '%''DECISION_REVERSED''%'
          and function_definition like '%array[''DECISION_REVERSED'']::text[]%'
      ) then 'PASS' else 'FAIL' end
    union all
    select 'no_canonical_or_apply_mutation',
      case when exists (
        select 1 from target_function
        where function_definition !~* (format('%s\\s+%s\\s+public\\.catalog_products', 'insert', 'into'))
          and function_definition !~* (format('%s\\s+public\\.catalog_products', 'update'))
          and function_definition !~* (format('%s\\s+%s\\s+public\\.catalog_products', 'delete', 'from'))
          and function_definition !~* (format('%s\\s+public\\.catalog_external_observations', 'update'))
          and function_definition !~* (format('%s\\s+%s\\s+public\\.catalog_external_observations', 'delete', 'from'))
          and function_definition !~* (format('%s\\s+public\\.catalog_observation_candidates', 'update'))
          and function_definition !~* 'record_catalog_observation_apply_event'
      ) then 'PASS' else 'FAIL' end
  )
  select gate
  into v_failed_gate
  from gate_results
  where status = 'FAIL'
  order by gate
  limit 1;

  if v_failed_gate is not null then
    raise exception 'BLOCKED: %', v_failed_gate;
  end if;
end;
$wp2f1_reversal_post_migration_gate$;

select 'WP2F1_REVERSAL_IDEMPOTENCY_DB_VERIFIED' as result;

rollback;
