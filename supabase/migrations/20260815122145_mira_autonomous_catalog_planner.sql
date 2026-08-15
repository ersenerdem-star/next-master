-- MIRA autonomous catalog planner.
--
-- This package creates bounded, tenant-scoped, review-only missions from
-- catalog gaps. It never writes catalog_products and never grants Apply.

set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.mira_missions
  add column if not exists origin text not null default 'manual',
  add column if not exists planner_key text,
  add column if not exists planner_score numeric(8, 3),
  add column if not exists planner_reason text,
  add column if not exists planner_context jsonb not null default '{}'::jsonb,
  add column if not exists target_brand text,
  add column if not exists requested_fields text[] not null default array[]::text[],
  add column if not exists max_items integer not null default 10;

alter table public.mira_missions
  drop constraint if exists mira_missions_origin_check;
alter table public.mira_missions
  add constraint mira_missions_origin_check
  check (origin in ('manual', 'planner'));

alter table public.mira_missions
  drop constraint if exists mira_missions_max_items_check;
alter table public.mira_missions
  add constraint mira_missions_max_items_check
  check (max_items between 1 and 50);

create unique index if not exists uq_mira_missions_active_planner_key
  on public.mira_missions (organization_id, planner_key)
  where planner_key is not null and status in ('queued', 'processing');

create table if not exists public.mira_planner_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  status text not null check (status in ('planned', 'idle', 'blocked', 'failed')),
  evaluated_scope_count integer not null default 0 check (evaluated_scope_count >= 0),
  created_mission_count integer not null default 0 check (created_mission_count >= 0),
  selected_mission_id uuid references public.mira_missions(id) on delete set null,
  reason text not null,
  decision_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_mira_planner_runs_org_created
  on public.mira_planner_runs (organization_id, created_at desc);

alter table public.mira_planner_runs enable row level security;
revoke all on table public.mira_planner_runs from public, anon, authenticated;
grant select, insert, update on table public.mira_planner_runs to service_role;

drop policy if exists mira_planner_runs_no_direct_access on public.mira_planner_runs;
create policy mira_planner_runs_no_direct_access
  on public.mira_planner_runs
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- The existing Febi source was already approved for bounded, read-only,
-- internal observation. Promote those exact approved flags to the canonical
-- top-level keys consumed by the MIRA intake guard; no other source is changed.
update public.catalog_external_sources
set metadata = jsonb_set(
      jsonb_set(coalesce(metadata, '{}'::jsonb), '{automated_read_only_approved}', 'true'::jsonb, true),
      '{internal_observation_allowed}', 'true'::jsonb, true
    ),
    updated_at = now()
where source_key = 'bilstein_group_partsfinder_observation'
  and is_active is true
  and license_posture = 'allowed'
  and robots_posture in ('allowed', 'not_applicable')
  and rate_limit_posture in ('bounded', 'restricted', 'not_applicable')
  and coalesce(nullif(lower(trim(credential_boundary)), ''), 'none') = 'none'
  and coalesce(
        (metadata #>> '{approval_scope,automated_read_only_approved}')::boolean,
        (metadata ->> 'automated_read_only_approved')::boolean,
        false
      ) is true
  and coalesce(
        (metadata #>> '{approval_scope,internal_observation_allowed}')::boolean,
        (metadata ->> 'internal_observation_allowed')::boolean,
        false
      ) is true;

update public.catalog_observation_jobs job
set metadata = jsonb_set(coalesce(job.metadata, '{}'::jsonb), '{mira_intake_protocol}', '"v1"'::jsonb, true),
    updated_at = now()
from public.catalog_external_sources source
where job.source_id = source.id
  and job.organization_id = source.organization_id
  and source.source_key = 'bilstein_group_partsfinder_observation'
  and source.is_active is true
  and source.license_posture = 'allowed'
  and job.status = 'active'
  and job.sync_mode = 'observation_only'
  and 'image_reference' = any(job.allowed_field_families);

-- Keeps the planner's first operational selector off a full catalog scan.
create index if not exists idx_catalog_products_mira_missing_image
  on public.catalog_products (organization_id, brand_id, product_code, id)
  where image_url is null or btrim(image_url) = '';

create or replace function public.plan_mira_catalog_missions(
  input_organization_id uuid,
  input_actor_id uuid default null,
  input_limit integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare
  v_actor_id uuid;
  v_actor_role text;
  v_limit integer := least(greatest(coalesce(input_limit, 1), 1), 3);
  v_run_id uuid := gen_random_uuid();
  v_existing_mission_id uuid;
  v_mission_id uuid;
  v_source public.catalog_external_sources%rowtype;
  v_trust public.catalog_external_source_trust_profiles%rowtype;
  v_job public.catalog_observation_jobs%rowtype;
  v_brand public.brands%rowtype;
  v_summary public.catalog_operations_brand_summary%rowtype;
  v_product_codes text[];
  v_normalized_codes text[];
  v_priced_candidate_count integer := 0;
  v_priced_brand_count integer := 0;
  v_max_items integer := 10;
  v_gap_ratio numeric := 0;
  v_score numeric := 0;
  v_reason text;
  v_context jsonb;
begin
  if input_organization_id is null then
    raise exception 'MIRA planner requires an organization';
  end if;

  select p.id, lower(coalesce(p.role::text, ''))
  into v_actor_id, v_actor_role
  from public.profiles p
  where p.organization_id = input_organization_id
    and p.is_active is true
    and lower(coalesce(p.role::text, '')) in ('superadmin', 'admin')
    and (input_actor_id is null or p.id = input_actor_id)
  order by case when lower(coalesce(p.role::text, '')) = 'superadmin' then 0 else 1 end,
           p.created_at,
           p.id
  limit 1;

  if v_actor_id is null or v_actor_role not in ('superadmin', 'admin') then
    raise exception 'MIRA planner requires an active organization admin actor';
  end if;

  select mission.id
  into v_existing_mission_id
  from public.mira_missions mission
  where mission.organization_id = input_organization_id
    and mission.origin = 'planner'
    and mission.status in ('queued', 'processing')
  order by mission.created_at
  limit 1;

  if v_existing_mission_id is not null then
    insert into public.mira_planner_runs (
      id, organization_id, actor_id, status, evaluated_scope_count,
      created_mission_count, selected_mission_id, reason, decision_context
    ) values (
      v_run_id, input_organization_id, v_actor_id, 'idle', 0,
      0, v_existing_mission_id,
      'An autonomous MIRA mission is already queued or processing.',
      jsonb_build_object('activeMissionId', v_existing_mission_id, 'queueGuard', 'one_active_planner_mission')
    );
    return jsonb_build_object(
      'status', 'idle',
      'plannerRunId', v_run_id,
      'createdCount', 0,
      'activeMissionId', v_existing_mission_id,
      'reason', 'An autonomous MIRA mission is already queued or processing.'
    );
  end if;

  select source.*
  into v_source
  from public.catalog_external_sources source
  where source.organization_id = input_organization_id
    and source.source_key = 'bilstein_group_partsfinder_observation'
    and source.is_active is true
    and source.license_posture = 'allowed'
    and source.robots_posture in ('allowed', 'not_applicable')
    and source.rate_limit_posture in ('bounded', 'restricted', 'not_applicable')
    and coalesce(nullif(lower(trim(source.credential_boundary)), ''), 'none') = 'none'
    and coalesce((source.metadata ->> 'automated_read_only_approved')::boolean, false) is true
    and coalesce((source.metadata ->> 'internal_observation_allowed')::boolean, false) is true
  order by source.updated_at desc, source.id
  limit 1;

  if v_source.id is null then
    v_reason := 'No admitted automatic observation source is available for the first planner route.';
  else
    select trust.*
    into v_trust
    from public.catalog_external_source_trust_profiles trust
    where trust.organization_id = input_organization_id
      and trust.source_id = v_source.id
      and trust.is_active is true
      and trust.evidence_required is true
      and trust.human_review_required is true
      and 'image_reference' = any(trust.allowed_field_families)
    order by trust.updated_at desc, trust.id
    limit 1;

    select job.*
    into v_job
    from public.catalog_observation_jobs job
    where job.organization_id = input_organization_id
      and job.source_id = v_source.id
      and job.trust_profile_id = v_trust.id
      and job.status = 'active'
      and job.sync_mode = 'observation_only'
      and job.metadata ->> 'mira_intake_protocol' = 'v1'
      and 'image_reference' = any(job.allowed_field_families)
    order by job.updated_at desc, job.id
    limit 1;

    if v_trust.id is null or v_job.id is null then
      v_reason := 'The admitted source has no active evidence-only MIRA trust/job scope.';
    else
      select brand.*
      into v_brand
      from public.brands brand
      where brand.organization_id = input_organization_id
        and brand.id = v_job.brand_id
        and lower(regexp_replace(brand.name, '[^a-z0-9]+', '', 'g')) in ('febi', 'febibilstein')
      limit 1;

      select summary.*
      into v_summary
      from public.catalog_operations_brand_summary summary
      where summary.organization_id = input_organization_id
        and summary.brand_id = v_brand.id;

      if v_brand.id is null or v_summary.brand_id is null or v_summary.missing_image_count <= 0 then
        v_reason := 'The admitted Febi scope has no current image gap to plan.';
      else
        select count(*)::integer
        into v_priced_brand_count
        from public.supplier_price_rollups rollup
        where rollup.organization_id = input_organization_id
          and rollup.brand_id = v_brand.id
          and rollup.cheapest_price is not null;

        select
          array_agg(candidate.product_code order by candidate.is_priced desc, candidate.product_code, candidate.id),
          array_agg(candidate.normalized_code order by candidate.is_priced desc, candidate.product_code, candidate.id),
          count(*) filter (where candidate.is_priced)::integer
        into v_product_codes, v_normalized_codes, v_priced_candidate_count
        from (
          select deduped.*
          from (
            select distinct on (cp.normalized_code)
              cp.id,
              cp.product_code,
              cp.normalized_code,
              exists (
                select 1
                from public.supplier_price_rollups rollup
                where rollup.organization_id = cp.organization_id
                  and rollup.brand_id = cp.brand_id
                  and rollup.normalized_code = cp.normalized_code
                  and rollup.cheapest_price is not null
              ) as is_priced
            from public.catalog_products cp
            where cp.organization_id = input_organization_id
              and cp.brand_id = v_brand.id
              and (cp.image_url is null or btrim(cp.image_url) = '')
              and nullif(btrim(cp.product_code), '') is not null
              and nullif(btrim(cp.normalized_code), '') is not null
              and not exists (
                select 1
                from public.catalog_external_observations observation
                where observation.organization_id = cp.organization_id
                  and observation.source_id = v_source.id
                  and observation.job_id = v_job.id
                  and observation.brand_id = cp.brand_id
                  and observation.normalized_code = cp.normalized_code
                  and observation.field_family = 'image_reference'
              )
            order by cp.normalized_code, cp.product_code, cp.id
          ) deduped
          order by deduped.is_priced desc, deduped.product_code, deduped.id
          limit v_max_items
        ) candidate;

        if coalesce(array_length(v_product_codes, 1), 0) = 0 then
          v_reason := 'All current Febi image gaps are already represented by observation evidence.';
        else
          v_gap_ratio := case when v_summary.total_products > 0
            then v_summary.missing_image_count::numeric / v_summary.total_products::numeric
            else 0 end;
          v_score := round(
            least(v_gap_ratio, 1) * 60
            + least(v_priced_brand_count::numeric / 1000, 1) * 30
            + least(v_summary.total_products::numeric / 100000, 1) * 10,
            3
          );
          v_reason := format(
            'Febi image coverage gap: %s of %s products; %s priced products increase commercial priority.',
            v_summary.missing_image_count,
            v_summary.total_products,
            v_priced_brand_count
          );
          v_context := jsonb_build_object(
            'protocolVersion', 'mira-autonomous-planner.v1',
            'targetBrand', v_brand.name,
            'sourceKey', v_source.source_key,
            'requestedFields', jsonb_build_array('image'),
            'productCodes', to_jsonb(v_product_codes),
            'normalizedCodes', to_jsonb(v_normalized_codes),
            'gapCount', v_summary.missing_image_count,
            'totalProducts', v_summary.total_products,
            'pricedBrandCount', v_priced_brand_count,
            'pricedCandidateCount', v_priced_candidate_count,
            'priorityScore', v_score,
            'reason', v_reason,
            'writeDisposition', 'observation-staging-only',
            'generatedAt', now()
          );

          insert into public.mira_missions (
            id, organization_id, created_by, objective, mission_area,
            max_pages, delay_ms, status, execution_mode,
            origin, planner_key, planner_score, planner_reason, planner_context,
            target_brand, requested_fields, max_items
          ) values (
            gen_random_uuid(), input_organization_id, v_actor_id,
            format(
              'Febi katalogundaki eksik ürün görselleri için resmi PartsFinder kaynağından kanıt topla. Ürün kodları: %s',
              array_to_string(v_product_codes, ', ')
            ),
            'Autonomous catalog enrichment',
            least(greatest(array_length(v_product_codes, 1), 1), 50),
            2000, 'queued', 'review_only',
            'planner',
            format('catalog-gap:%s:image_reference', v_job.id),
            v_score, v_reason, v_context,
            v_brand.name, array['image']::text[], array_length(v_product_codes, 1)
          )
          returning id into v_mission_id;
        end if;
      end if;
    end if;
  end if;

  insert into public.mira_planner_runs (
    id, organization_id, actor_id, status, evaluated_scope_count,
    created_mission_count, selected_mission_id, reason, decision_context
  ) values (
    v_run_id,
    input_organization_id,
    v_actor_id,
    case when v_mission_id is null then 'idle' else 'planned' end,
    case when v_source.id is null then 0 else 1 end,
    case when v_mission_id is null then 0 else 1 end,
    v_mission_id,
    coalesce(v_reason, 'No eligible autonomous catalog gap was selected.'),
    coalesce(v_context, jsonb_build_object(
      'protocolVersion', 'mira-autonomous-planner.v1',
      'reason', coalesce(v_reason, 'No eligible autonomous catalog gap was selected.'),
      'writeDisposition', 'observation-staging-only'
    ))
  );

  return jsonb_build_object(
    'status', case when v_mission_id is null then 'idle' else 'planned' end,
    'plannerRunId', v_run_id,
    'createdCount', case when v_mission_id is null then 0 else 1 end,
    'missionId', v_mission_id,
    'score', v_score,
    'reason', coalesce(v_reason, 'No eligible autonomous catalog gap was selected.'),
    'context', coalesce(v_context, '{}'::jsonb),
    'requestedLimit', v_limit
  );
exception
  when unique_violation then
    select mission.id into v_existing_mission_id
    from public.mira_missions mission
    where mission.organization_id = input_organization_id
      and mission.origin = 'planner'
      and mission.status in ('queued', 'processing')
    order by mission.created_at
    limit 1;
    return jsonb_build_object(
      'status', 'idle',
      'plannerRunId', v_run_id,
      'createdCount', 0,
      'activeMissionId', v_existing_mission_id,
      'reason', 'Another planner cycle created the active mission first.'
    );
end;
$$;

revoke all on function public.plan_mira_catalog_missions(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.plan_mira_catalog_missions(uuid, uuid, integer)
  to service_role;

comment on table public.mira_planner_runs is
  'Tenant-scoped MIRA planner decisions. Planner creates review-only missions and never mutates Catalog products.';
comment on function public.plan_mira_catalog_missions(uuid, uuid, integer) is
  'Creates at most one bounded autonomous evidence mission from an admitted Catalog gap. No Catalog write or Apply.';
