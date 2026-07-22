-- NM-CATALOG-WP2-F1 hotfix: expose DB-canonical review fingerprints to the API read path.
-- This does not mutate Product, observations, recommendations, or decision ledger rows.

create or replace function public.get_catalog_observation_review_fingerprints(input_review_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid := public.current_profile_org_id();
  v_profile public.profiles%rowtype;
  v_parsed record;
  v_observation public.catalog_external_observations%rowtype;
  v_product public.catalog_products%rowtype;
  v_observation_fingerprint text;
  v_product_target_fingerprint text;
  v_review_item_fingerprint text;
begin
  if v_actor_id is null or v_org_id is null then
    raise exception 'CATALOG_REVIEW_DECISION_UNAUTHORIZED: active profile required'
      using errcode = 'P0001';
  end if;

  select *
  into v_profile
  from public.profiles p
  where p.id = v_actor_id
    and p.organization_id = v_org_id
    and coalesce(p.is_active, true)
    and lower(coalesce(p.role, '')) in ('admin', 'superadmin')
  limit 1;

  if not found then
    raise exception 'CATALOG_REVIEW_DECISION_UNAUTHORIZED: admin or superadmin required'
      using errcode = 'P0001';
  end if;

  select * into v_parsed from public.catalog_review_parse_review_item_id(input_review_item_id);
  if v_parsed.organization_id <> v_org_id then
    raise exception 'CATALOG_REVIEW_DECISION_ORGANIZATION_MISMATCH: review item organization mismatch'
      using errcode = 'P0001';
  end if;

  select * into v_observation
  from public.catalog_external_observations o
  where o.id = v_parsed.observation_id
    and o.organization_id = v_org_id
    and o.catalog_product_id = v_parsed.catalog_product_id
    and o.field_family = v_parsed.field_family
  limit 1;

  if not found then
    raise exception 'CATALOG_REVIEW_ITEM_MISSING: observation is not part of review item'
      using errcode = 'P0001';
  end if;

  select * into v_product
  from public.catalog_products p
  where p.id = v_parsed.catalog_product_id
    and p.organization_id = v_org_id
  limit 1;

  if not found then
    raise exception 'CATALOG_REVIEW_ITEM_MISSING: Product is not part of review item'
      using errcode = 'P0001';
  end if;

  v_observation_fingerprint := public.catalog_review_observation_fingerprint(v_observation);
  v_product_target_fingerprint := public.catalog_review_product_target_fingerprint(v_parsed.field_family, v_product);
  v_review_item_fingerprint := public.catalog_review_item_fingerprint(input_review_item_id, v_observation, v_product);

  return jsonb_build_object(
    'organization_id', v_org_id,
    'review_item_id', input_review_item_id,
    'observation_fingerprint', v_observation_fingerprint,
    'product_target_fingerprint', v_product_target_fingerprint,
    'review_item_fingerprint', v_review_item_fingerprint
  );
end;
$$;

revoke all on function public.get_catalog_observation_review_fingerprints(text) from public, anon, authenticated, service_role;
grant execute on function public.get_catalog_observation_review_fingerprints(text) to authenticated;

comment on function public.get_catalog_observation_review_fingerprints(text) is
  'WP2-F1 read-contract helper returning DB-canonical fingerprints for one review item. No Product, observation, recommendation, or ledger mutation is performed.';
