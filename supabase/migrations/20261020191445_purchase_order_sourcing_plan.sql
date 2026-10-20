-- One review and one transaction for a multi-supplier sourcing decision.
-- Per-supplier receipts retain full before/after evidence; the plan receipt
-- makes retries safe even when a response is lost after commit.
create table public.purchase_order_sourcing_plans (
  organization_id uuid not null references public.organizations(id),
  decision_id uuid not null,
  actor_id uuid not null,
  source_order_id text not null,
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, decision_id)
);
alter table public.purchase_order_sourcing_plans enable row level security;
revoke all on public.purchase_order_sourcing_plans from public, anon, authenticated, service_role;
grant select on public.purchase_order_sourcing_plans to authenticated, service_role;
create policy purchase_sourcing_plan_read on public.purchase_order_sourcing_plans for select to authenticated
  using (organization_id=public.current_profile_org_id()
    and (public.current_profile_role() in ('admin','sales') or public.is_superadmin()));

create function public.apply_purchase_order_sourcing_plan_atomic(payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_actor uuid := auth.uid();
  v_decision uuid := (payload->>'decision_id')::uuid;
  v_source_id text := payload->>'source_order_id';
  v_source public.purchase_orders%rowtype;
  v_receipt public.purchase_order_sourcing_plans%rowtype;
  v_group jsonb;
  v_number integer;
  v_moved integer[] := '{}';
  v_all_indices integer[];
  v_indices jsonb;
  v_prices jsonb;
  v_result jsonb;
  v_change jsonb;
  v_targets jsonb := '[]';
begin
  if v_actor is null or v_org is null
    or (coalesce(public.current_profile_role(),'') not in ('admin','sales') and not coalesce(public.is_superadmin(),false)) then
    raise exception 'PURCHASE_SUPPLIER_ACCESS_DENIED';
  end if;
  if v_decision is null or nullif(v_source_id,'') is null then raise exception 'PURCHASE_SUPPLIER_REQUEST_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_org::text||v_decision::text,0));
  select * into v_receipt from public.purchase_order_sourcing_plans where organization_id=v_org and decision_id=v_decision;
  if found then
    if v_receipt.actor_id<>v_actor or v_receipt.request<>payload then raise exception 'PURCHASE_SUPPLIER_REPLAY_CONFLICT'; end if;
    return v_receipt.result||jsonb_build_object('replayed',true);
  end if;
  if jsonb_typeof(payload->'groups') is distinct from 'array' then raise exception 'PURCHASE_SUPPLIER_PLAN_INVALID'; end if;
  if jsonb_array_length(payload->'groups') not between 1 and 50 then raise exception 'PURCHASE_SUPPLIER_PLAN_INVALID'; end if;
  if exists(select 1 from jsonb_array_elements(payload->'groups') g
    where jsonb_typeof(g->'line_indices') is distinct from 'array' or jsonb_typeof(g->'expected_prices') is distinct from 'array') then
    raise exception 'PURCHASE_SUPPLIER_LINES_INVALID';
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'groups') g, jsonb_array_elements(g->'line_indices') i
    where jsonb_typeof(i)<>'number' or i::text !~ '^(0|[1-9][0-9]*)$') then raise exception 'PURCHASE_SUPPLIER_LINES_INVALID'; end if;
  select array_agg(i::text::integer) into v_all_indices
    from jsonb_array_elements(payload->'groups') g, jsonb_array_elements(g->'line_indices') i;
  if coalesce(cardinality(v_all_indices),0)=0 or cardinality(v_all_indices)<>(select count(distinct i) from unnest(v_all_indices) i)
    or (select count(distinct g->>'supplier_id') from jsonb_array_elements(payload->'groups') g)<>jsonb_array_length(payload->'groups') then
    raise exception 'PURCHASE_SUPPLIER_PLAN_INVALID';
  end if;
  select * into v_source from public.purchase_orders where organization_id=v_org and id=v_source_id;
  if not found then raise exception 'PURCHASE_SUPPLIER_ORDER_NOT_FOUND'; end if;
  perform 1 from public.sales_orders where organization_id=v_org and id=v_source.sales_order_id and status='confirmed' for update;
  if not found then raise exception 'PURCHASE_SUPPLIER_CONFIRMED_SALE_REQUIRED'; end if;
  -- Lock every destination before writing, in the same document order for all plans.
  perform 1 from public.purchase_orders where organization_id=v_org and (
    id=v_source_id or id in (select g->>'target_order_id' from jsonb_array_elements(payload->'groups') g)) order by id for update;
  select * into v_source from public.purchase_orders where organization_id=v_org and id=v_source_id;
  if v_source.updated_at is distinct from (payload->>'expected_source_updated_at')::timestamptz then raise exception 'PURCHASE_SUPPLIER_ORDER_CHANGED'; end if;
  if exists(select 1 from unnest(v_all_indices) i where i>=jsonb_array_length(v_source.lines)) then raise exception 'PURCHASE_SUPPLIER_LINES_INVALID'; end if;

  for v_group,v_number in select value,ordinality::integer from jsonb_array_elements(payload->'groups') with ordinality loop
    -- Client line indices refer to the original document. Earlier groups have
    -- removed demand, so remap indices without matching/reordering by SKU.
    select jsonb_agg(i::text::integer-(select count(*)::integer from unnest(v_moved) m where m<i::text::integer) order by n)
      into v_indices from jsonb_array_elements(v_group->'line_indices') with ordinality a(i,n);
    select jsonb_agg(e||jsonb_build_object('line_index',(e->>'line_index')::integer-
      (select count(*)::integer from unnest(v_moved) m where m<(e->>'line_index')::integer)))
      into v_prices from jsonb_array_elements(v_group->'expected_prices') e;
    v_change:=public.reassign_purchase_order_supplier_atomic(jsonb_build_object(
      'decision_id',md5(v_decision::text||':'||v_number::text)::uuid,
      'source_order_id',v_source_id,'expected_source_updated_at',v_source.updated_at,
      'supplier_id',v_group->>'supplier_id','target_order_id',v_group->>'target_order_id',
      'expected_target_updated_at',v_group->>'expected_target_updated_at',
      'line_indices',v_indices,'expected_prices',v_prices,'reason',payload->>'reason'));
    v_targets:=v_targets||jsonb_build_array(v_change->'target_order');
    select v_moved||array_agg(i::text::integer) into v_moved from jsonb_array_elements(v_group->'line_indices') i;
    select * into v_source from public.purchase_orders where organization_id=v_org and id=v_source_id;
  end loop;
  v_result:=jsonb_build_object('source_order',to_jsonb(v_source),'target_orders',v_targets,'replayed',false);
  insert into public.purchase_order_sourcing_plans(organization_id,decision_id,actor_id,source_order_id,request,result)
    values(v_org,v_decision,v_actor,v_source_id,payload,v_result);
  return v_result;
end;
$$;
revoke all on function public.apply_purchase_order_sourcing_plan_atomic(jsonb) from public,anon;
grant execute on function public.apply_purchase_order_sourcing_plan_atomic(jsonb) to authenticated;
