-- RAP-A3: incremental catalog integrity projection and bounded processing queue.

create table if not exists public.catalog_product_integrity (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.catalog_products(id) on delete cascade,
  status text not null default 'unknown'
    check (status in ('unknown', 'queued', 'evaluating', 'clear', 'incomplete', 'conflict', 'failed')),
  critical_missing_fields text[] not null default array[]::text[],
  optional_missing_fields text[] not null default array[]::text[],
  conflict_fields text[] not null default array[]::text[],
  pending_conflict_count integer not null default 0 check (pending_conflict_count >= 0),
  last_evaluated_at timestamptz,
  last_product_change_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, product_id)
);

create index if not exists idx_catalog_product_integrity_org_status
  on public.catalog_product_integrity (organization_id, status, updated_at desc);

create index if not exists idx_catalog_product_integrity_org_missing_ean
  on public.catalog_product_integrity (organization_id, product_id)
  where optional_missing_fields @> array['ean']::text[];

create table if not exists public.catalog_integrity_queue (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.catalog_products(id) on delete cascade,
  reason text not null,
  priority integer not null default 0,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, product_id)
);

create index if not exists idx_catalog_integrity_queue_claim
  on public.catalog_integrity_queue (priority desc, next_attempt_at, updated_at, product_id)
  where status = 'queued';

create index if not exists idx_catalog_integrity_queue_stale_lock
  on public.catalog_integrity_queue (locked_at)
  where status = 'processing';

create table if not exists public.catalog_integrity_backfill_state (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  last_product_id uuid,
  total_products bigint,
  queued_products bigint not null default 0,
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text
);

alter table public.catalog_product_integrity enable row level security;
alter table public.catalog_integrity_queue enable row level security;
alter table public.catalog_integrity_backfill_state enable row level security;

drop policy if exists catalog_product_integrity_select_org on public.catalog_product_integrity;
create policy catalog_product_integrity_select_org
on public.catalog_product_integrity
for select
using (
  auth.uid() is not null
  and organization_id = public.current_profile_org_id()
);

grant select on public.catalog_product_integrity to authenticated;
grant select, insert, update, delete on public.catalog_product_integrity to service_role;
grant select, insert, update, delete on public.catalog_integrity_queue to service_role;
grant select, insert, update, delete on public.catalog_integrity_backfill_state to service_role;

create or replace function public.enqueue_catalog_integrity_product(
  input_organization_id uuid,
  input_product_id uuid,
  input_reason text,
  input_priority integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if input_organization_id is null or input_product_id is null then
    return;
  end if;

  insert into public.catalog_integrity_queue (
    organization_id,
    product_id,
    reason,
    priority,
    status,
    attempt_count,
    next_attempt_at,
    locked_at,
    lock_token,
    locked_by,
    last_error,
    updated_at
  ) values (
    input_organization_id,
    input_product_id,
    left(coalesce(nullif(trim(input_reason), ''), 'product_changed'), 120),
    input_priority,
    'queued',
    0,
    now(),
    null,
    null,
    null,
    null,
    now()
  )
  on conflict (organization_id, product_id)
  do update set
    reason = excluded.reason,
    priority = greatest(public.catalog_integrity_queue.priority, excluded.priority),
    status = 'queued',
    attempt_count = 0,
    next_attempt_at = now(),
    locked_at = null,
    lock_token = null,
    locked_by = null,
    last_error = null,
    updated_at = now();

  insert into public.catalog_product_integrity (
    organization_id,
    product_id,
    status,
    last_product_change_at,
    updated_at
  ) values (
    input_organization_id,
    input_product_id,
    'queued',
    now(),
    now()
  )
  on conflict (organization_id, product_id)
  do update set
    status = 'queued',
    last_product_change_at = now(),
    last_error = null,
    updated_at = now();
end;
$$;

revoke all on function public.enqueue_catalog_integrity_product(uuid, uuid, text, integer) from public;

create or replace function public.queue_catalog_product_integrity_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and old.description is not distinct from new.description
     and old.origin is not distinct from new.origin
     and old.hs_code is not distinct from new.hs_code
     and old.weight_kg is not distinct from new.weight_kg
     and old.ean is not distinct from new.ean then
    return new;
  end if;

  perform public.enqueue_catalog_integrity_product(
    new.organization_id,
    new.id,
    case when tg_op = 'INSERT' then 'product_inserted' else 'protected_fields_changed' end,
    case when tg_op = 'INSERT' then 20 else 40 end
  );
  return new;
end;
$$;

revoke all on function public.queue_catalog_product_integrity_change() from public;

drop trigger if exists trg_catalog_products_queue_integrity on public.catalog_products;
create trigger trg_catalog_products_queue_integrity
after insert or update of description, origin, hs_code, weight_kg, ean
on public.catalog_products
for each row
execute function public.queue_catalog_product_integrity_change();

do $$
declare
  v_constraint_name text;
begin
  select c.conname
  into v_constraint_name
  from pg_constraint c
  where c.conrelid = 'public.product_attribute_conflicts'::regclass
    and c.confrelid = 'public.catalog_products'::regclass
    and c.contype = 'f'
    and c.conkey = array[
      (
        select a.attnum
        from pg_attribute a
        where a.attrelid = 'public.product_attribute_conflicts'::regclass
          and a.attname = 'product_id'
      )
    ]::smallint[]
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.product_attribute_conflicts drop constraint %I', v_constraint_name);
  end if;

  alter table public.product_attribute_conflicts
    add constraint product_attribute_conflicts_product_id_fkey
    foreign key (product_id)
    references public.catalog_products(id)
    on delete cascade;
end;
$$;

create or replace function public.queue_product_conflict_integrity_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_product_id uuid;
begin
  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status then
    return new;
  end if;

  if tg_op = 'DELETE' then
    v_organization_id := old.organization_id;
    v_product_id := old.product_id;

    if not exists (
      select 1
      from public.catalog_products cp
      where cp.organization_id = v_organization_id
        and cp.id = v_product_id
    ) then
      return old;
    end if;
  else
    v_organization_id := new.organization_id;
    v_product_id := new.product_id;
  end if;

  perform public.enqueue_catalog_integrity_product(
    v_organization_id,
    v_product_id,
    case
      when tg_op = 'INSERT' then 'conflict_detected'
      when tg_op = 'DELETE' then 'conflict_removed'
      else 'conflict_status_changed'
    end,
    100
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.queue_product_conflict_integrity_change() from public;

drop trigger if exists trg_product_attribute_conflicts_queue_integrity on public.product_attribute_conflicts;
create trigger trg_product_attribute_conflicts_queue_integrity
after insert or delete or update of status
on public.product_attribute_conflicts
for each row
execute function public.queue_product_conflict_integrity_change();

create or replace function public.enqueue_catalog_integrity_backfill_batch(
  input_chunk_size integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.catalog_integrity_backfill_state%rowtype;
  v_chunk_size integer := least(greatest(coalesce(input_chunk_size, 1000), 1), 2000);
  v_last_product_id uuid;
  v_queued integer := 0;
  v_complete boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Catalog integrity backfill requires service role';
  end if;

  insert into public.catalog_integrity_backfill_state (organization_id, status)
  select o.id, 'queued'
  from public.organizations o
  on conflict (organization_id) do nothing;

  select s.*
  into v_state
  from public.catalog_integrity_backfill_state s
  where s.status in ('queued', 'running')
  order by s.updated_at, s.organization_id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('complete', true, 'queued_count', 0);
  end if;

  if v_state.total_products is null then
    select count(*)
    into v_state.total_products
    from public.catalog_products cp
    where cp.organization_id = v_state.organization_id;
  end if;

  with batch as (
    select cp.id
    from public.catalog_products cp
    where cp.organization_id = v_state.organization_id
      and (v_state.last_product_id is null or cp.id > v_state.last_product_id)
    order by cp.id
    limit v_chunk_size
  ), queued as (
    insert into public.catalog_integrity_queue (
      organization_id,
      product_id,
      reason,
      priority,
      status,
      attempt_count,
      next_attempt_at,
      updated_at
    )
    select v_state.organization_id, batch.id, 'initial_backfill', 5, 'queued', 0, now(), now()
    from batch
    on conflict (organization_id, product_id)
    do update set
      reason = case
        when public.catalog_integrity_queue.status = 'completed' then excluded.reason
        else public.catalog_integrity_queue.reason
      end,
      priority = greatest(public.catalog_integrity_queue.priority, excluded.priority),
      status = case
        when public.catalog_integrity_queue.status = 'completed' then 'queued'
        else public.catalog_integrity_queue.status
      end,
      next_attempt_at = case
        when public.catalog_integrity_queue.status = 'completed' then now()
        else public.catalog_integrity_queue.next_attempt_at
      end,
      updated_at = now()
    returning product_id
  ), projected as (
    insert into public.catalog_product_integrity (organization_id, product_id, status, updated_at)
    select v_state.organization_id, queued.product_id, 'queued', now()
    from queued
    on conflict (organization_id, product_id) do nothing
    returning product_id
  )
  select count(*), max(product_id)
  into v_queued, v_last_product_id
  from queued;

  v_complete := v_queued < v_chunk_size;

  update public.catalog_integrity_backfill_state
  set status = case when v_complete then 'completed' else 'running' end,
      last_product_id = coalesce(v_last_product_id, last_product_id),
      total_products = v_state.total_products,
      queued_products = queued_products + v_queued,
      started_at = coalesce(started_at, now()),
      completed_at = case when v_complete then now() else null end,
      last_error = null,
      updated_at = now()
  where organization_id = v_state.organization_id;

  return jsonb_build_object(
    'complete', v_complete,
    'organization_id', v_state.organization_id,
    'queued_count', v_queued,
    'total_products', v_state.total_products,
    'last_product_id', coalesce(v_last_product_id, v_state.last_product_id)
  );
exception when others then
  if v_state.organization_id is not null then
    update public.catalog_integrity_backfill_state
    set status = 'failed', last_error = sqlerrm, updated_at = now()
    where organization_id = v_state.organization_id;
  end if;
  raise;
end;
$$;

revoke all on function public.enqueue_catalog_integrity_backfill_batch(integer) from public;
grant execute on function public.enqueue_catalog_integrity_backfill_batch(integer) to service_role;

create or replace function public.claim_catalog_integrity_batch(
  input_batch_size integer default 100,
  input_worker_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_size integer := least(greatest(coalesce(input_batch_size, 100), 1), 250);
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Catalog integrity batch claim requires service role';
  end if;

  with stale as (
    update public.catalog_integrity_queue q
    set status = 'queued',
        next_attempt_at = now(),
        locked_at = null,
        lock_token = null,
        locked_by = null,
        last_error = coalesce(q.last_error, 'Stale processing lock released'),
        updated_at = now()
    where q.status = 'processing'
      and q.locked_at < now() - interval '10 minutes'
    returning q.organization_id, q.product_id
  )
  update public.catalog_product_integrity i
  set status = 'queued', updated_at = now()
  from stale
  where i.organization_id = stale.organization_id
    and i.product_id = stale.product_id;

  with candidates as (
    select q.organization_id, q.product_id
    from public.catalog_integrity_queue q
    where q.status = 'queued'
      and q.next_attempt_at <= now()
    order by q.priority desc, q.next_attempt_at, q.updated_at, q.product_id
    for update skip locked
    limit v_batch_size
  ), claimed as (
    update public.catalog_integrity_queue q
    set status = 'processing',
        attempt_count = q.attempt_count + 1,
        locked_at = now(),
        lock_token = gen_random_uuid(),
        locked_by = nullif(trim(coalesce(input_worker_id, '')), ''),
        last_error = null,
        updated_at = now()
    from candidates c
    where q.organization_id = c.organization_id
      and q.product_id = c.product_id
    returning q.organization_id, q.product_id, q.lock_token, q.attempt_count
  ), marked as (
    update public.catalog_product_integrity i
    set status = 'evaluating', last_error = null, updated_at = now()
    from claimed c
    where i.organization_id = c.organization_id
      and i.product_id = c.product_id
    returning i.product_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'organization_id', c.organization_id,
        'product_id', c.product_id,
        'lock_token', c.lock_token,
        'attempt_count', c.attempt_count
      ) order by c.product_id
    ),
    '[]'::jsonb
  )
  into v_result
  from claimed c;

  return v_result;
end;
$$;

revoke all on function public.claim_catalog_integrity_batch(integer, text) from public;
grant execute on function public.claim_catalog_integrity_batch(integer, text) to service_role;

create or replace function public.evaluate_catalog_integrity_batch(input_claims jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evaluated integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Catalog integrity evaluation requires service role';
  end if;
  if jsonb_typeof(input_claims) <> 'array' then
    raise exception 'Catalog integrity claims must be a JSON array';
  end if;

  with requested as (
    select organization_id, product_id, lock_token
    from jsonb_to_recordset(input_claims) as x(
      organization_id uuid,
      product_id uuid,
      lock_token uuid
    )
  ), claimed as (
    select q.organization_id, q.product_id, q.lock_token
    from requested r
    join public.catalog_integrity_queue q
      on q.organization_id = r.organization_id
     and q.product_id = r.product_id
     and q.lock_token = r.lock_token
     and q.status = 'processing'
  ), conflict_state as (
    select
      c.organization_id,
      c.product_id,
      count(pac.id)::integer as pending_conflict_count,
      coalesce(array_agg(distinct pac.field_name order by pac.field_name)
        filter (where pac.id is not null), array[]::text[]) as conflict_fields
    from claimed c
    left join public.product_attribute_conflicts pac
      on pac.organization_id = c.organization_id
     and pac.product_id = c.product_id
     and pac.status = 'pending_review'
    group by c.organization_id, c.product_id
  ), evaluated as (
    select
      c.organization_id,
      c.product_id,
      array_remove(array[
        case when nullif(trim(coalesce(cp.description, '')), '') is null then 'description' end,
        case when nullif(trim(coalesce(cp.origin, '')), '') is null then 'origin' end,
        case when nullif(trim(coalesce(cp.hs_code, '')), '') is null then 'hs_code' end,
        case when cp.weight_kg is null then 'weight_kg' end
      ], null)::text[] as critical_missing_fields,
      array_remove(array[
        case when nullif(trim(coalesce(cp.ean, '')), '') is null then 'ean' end
      ], null)::text[] as optional_missing_fields,
      cs.conflict_fields,
      cs.pending_conflict_count,
      case
        when cs.pending_conflict_count > 0 then 'conflict'
        when cardinality(array_remove(array[
          case when nullif(trim(coalesce(cp.description, '')), '') is null then 'description' end,
          case when nullif(trim(coalesce(cp.origin, '')), '') is null then 'origin' end,
          case when nullif(trim(coalesce(cp.hs_code, '')), '') is null then 'hs_code' end,
          case when cp.weight_kg is null then 'weight_kg' end
        ], null)) > 0 then 'incomplete'
        else 'clear'
      end as integrity_status
    from claimed c
    join public.catalog_products cp
      on cp.organization_id = c.organization_id
     and cp.id = c.product_id
    join conflict_state cs
      on cs.organization_id = c.organization_id
     and cs.product_id = c.product_id
  ), projected as (
    insert into public.catalog_product_integrity (
      organization_id,
      product_id,
      status,
      critical_missing_fields,
      optional_missing_fields,
      conflict_fields,
      pending_conflict_count,
      last_evaluated_at,
      last_error,
      updated_at
    )
    select
      e.organization_id,
      e.product_id,
      e.integrity_status,
      e.critical_missing_fields,
      e.optional_missing_fields,
      e.conflict_fields,
      e.pending_conflict_count,
      now(),
      null,
      now()
    from evaluated e
    on conflict (organization_id, product_id)
    do update set
      status = excluded.status,
      critical_missing_fields = excluded.critical_missing_fields,
      optional_missing_fields = excluded.optional_missing_fields,
      conflict_fields = excluded.conflict_fields,
      pending_conflict_count = excluded.pending_conflict_count,
      last_evaluated_at = excluded.last_evaluated_at,
      last_error = null,
      updated_at = now()
    returning organization_id, product_id
  ), completed as (
    update public.catalog_integrity_queue q
    set status = 'completed',
        locked_at = null,
        lock_token = null,
        locked_by = null,
        last_error = null,
        updated_at = now()
    from projected p
    where q.organization_id = p.organization_id
      and q.product_id = p.product_id
    returning q.product_id
  )
  select count(*) into v_evaluated from completed;

  return jsonb_build_object('evaluated_count', v_evaluated);
end;
$$;

revoke all on function public.evaluate_catalog_integrity_batch(jsonb) from public;
grant execute on function public.evaluate_catalog_integrity_batch(jsonb) to service_role;

create or replace function public.fail_catalog_integrity_batch(
  input_claims jsonb,
  input_error text,
  input_retry boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Catalog integrity batch failure handling requires service role';
  end if;
  if jsonb_typeof(input_claims) <> 'array' then
    raise exception 'Catalog integrity claims must be a JSON array';
  end if;

  with requested as (
    select organization_id, product_id, lock_token
    from jsonb_to_recordset(input_claims) as x(
      organization_id uuid,
      product_id uuid,
      lock_token uuid
    )
  ), failed as (
    update public.catalog_integrity_queue q
    set status = case when input_retry and q.attempt_count < 5 then 'queued' else 'failed' end,
        next_attempt_at = case
          when input_retry and q.attempt_count < 5
            then now() + make_interval(secs => least(300, (5 * power(2, q.attempt_count))::integer))
          else q.next_attempt_at
        end,
        locked_at = null,
        lock_token = null,
        locked_by = null,
        last_error = left(coalesce(nullif(trim(input_error), ''), 'Catalog integrity evaluation failed'), 1000),
        updated_at = now()
    from requested r
    where q.organization_id = r.organization_id
      and q.product_id = r.product_id
      and q.lock_token = r.lock_token
      and q.status = 'processing'
    returning q.organization_id, q.product_id, q.status, q.last_error
  ), projected as (
    update public.catalog_product_integrity i
    set status = case when f.status = 'failed' then 'failed' else 'queued' end,
        last_error = f.last_error,
        updated_at = now()
    from failed f
    where i.organization_id = f.organization_id
      and i.product_id = f.product_id
    returning i.product_id
  )
  select count(*) into v_updated from failed;

  return jsonb_build_object('updated_count', v_updated);
end;
$$;

revoke all on function public.fail_catalog_integrity_batch(jsonb, text, boolean) from public;
grant execute on function public.fail_catalog_integrity_batch(jsonb, text, boolean) to service_role;

create or replace function public.get_catalog_integrity_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with org as (
    select public.current_profile_org_id() as organization_id
  ), counts as (
    select
      count(*)::bigint as total_products,
      count(*) filter (where i.status = 'clear')::bigint as clear_count,
      count(*) filter (where i.status = 'incomplete')::bigint as incomplete_count,
      count(*) filter (where i.status = 'conflict')::bigint as conflict_count,
      count(*) filter (where i.status in ('unknown', 'queued', 'evaluating'))::bigint as pending_count,
      count(*) filter (where i.status = 'failed')::bigint as failed_count,
      max(i.last_evaluated_at) as last_evaluated_at
    from public.catalog_product_integrity i
    join org on org.organization_id = i.organization_id
  ), backfill as (
    select s.status, s.total_products, s.queued_products, s.updated_at, s.last_error
    from public.catalog_integrity_backfill_state s
    join org on org.organization_id = s.organization_id
  )
  select jsonb_build_object(
    'total_products', coalesce(backfill.total_products, counts.total_products, 0),
    'projected_products', coalesce(counts.total_products, 0),
    'clear_count', coalesce(counts.clear_count, 0),
    'incomplete_count', coalesce(counts.incomplete_count, 0),
    'conflict_count', coalesce(counts.conflict_count, 0),
    'pending_count', coalesce(counts.pending_count, 0),
    'failed_count', coalesce(counts.failed_count, 0),
    'last_evaluated_at', counts.last_evaluated_at,
    'backfill_status', coalesce(backfill.status, 'queued'),
    'backfill_queued_products', coalesce(backfill.queued_products, 0),
    'backfill_updated_at', backfill.updated_at,
    'backfill_error', backfill.last_error
  )
  from counts
  left join backfill on true;
$$;

revoke all on function public.get_catalog_integrity_summary() from public;
grant execute on function public.get_catalog_integrity_summary() to authenticated;

create or replace function public.get_catalog_product_integrity(input_product_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select to_jsonb(i)
      from public.catalog_product_integrity i
      where i.organization_id = public.current_profile_org_id()
        and i.product_id = input_product_id
    ),
    jsonb_build_object(
      'organization_id', public.current_profile_org_id(),
      'product_id', input_product_id,
      'status', 'unknown',
      'critical_missing_fields', array[]::text[],
      'optional_missing_fields', array[]::text[],
      'conflict_fields', array[]::text[],
      'pending_conflict_count', 0
    )
  );
$$;

revoke all on function public.get_catalog_product_integrity(uuid) from public;
grant execute on function public.get_catalog_product_integrity(uuid) to authenticated;

drop function if exists public.cloud_catalog_integrity_page(text, text, text, text, integer, integer);

create or replace function public.cloud_catalog_integrity_page(
  input_search text default '',
  input_brand text default '',
  input_market_segment text default '',
  input_integrity_filter text default '',
  input_page integer default 1,
  input_page_size integer default 50
)
returns table (
  total_count bigint,
  has_more boolean,
  product_id uuid,
  product_code text,
  brand text,
  image_url text,
  market_segment text,
  description text,
  oem_no text,
  vehicle text,
  hs_code text,
  origin text,
  weight_kg numeric,
  ean text,
  lifecycle_status text,
  lifecycle_note text,
  integrity_status text,
  critical_missing_fields text[],
  optional_missing_fields text[],
  conflict_fields text[],
  pending_conflict_count integer,
  last_evaluated_at timestamptz,
  integrity_last_error text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select
      public.current_profile_org_id() as organization_id,
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      public.normalize_part_code(input_search) as search_norm,
      public.normalize_part_code(input_brand) as brand_norm,
      coalesce(public.normalize_catalog_market_segment(input_market_segment), '') as segment_norm,
      lower(trim(coalesce(input_integrity_filter, ''))) as integrity_filter,
      least(greatest(coalesce(input_page_size, 50), 1), 250) as page_size,
      greatest(0, (greatest(coalesce(input_page, 1), 1) - 1)
        * least(greatest(coalesce(input_page_size, 50), 1), 250)) as row_offset
  ), filtered as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.image_url,
      cp.market_segment,
      cp.description,
      cp.oem_no,
      cp.vehicle,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.ean,
      cp.lifecycle_status,
      cp.lifecycle_note,
      coalesce(i.status, 'unknown') as integrity_status,
      coalesce(i.critical_missing_fields, array[]::text[]) as critical_missing_fields,
      coalesce(i.optional_missing_fields, array[]::text[]) as optional_missing_fields,
      coalesce(i.conflict_fields, array[]::text[]) as conflict_fields,
      coalesce(i.pending_conflict_count, 0) as pending_conflict_count,
      i.last_evaluated_at,
      i.last_error as integrity_last_error
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    left join public.catalog_product_integrity i
      on i.organization_id = cp.organization_id
     and i.product_id = cp.id
    cross join params p
    where cp.organization_id = p.organization_id
      and (p.brand_norm = '' or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = p.brand_norm)
      and (p.segment_norm = '' or coalesce(public.normalize_catalog_market_segment(cp.market_segment), '') = p.segment_norm)
      and (
        p.raw_search is null
        or cp.product_code ilike '%' || p.raw_search || '%'
        or coalesce(cp.description, '') ilike '%' || p.raw_search || '%'
        or coalesce(cp.oem_no, '') ilike '%' || p.raw_search || '%'
        or cp.normalized_code like '%' || p.search_norm || '%'
        or coalesce(cp.normalized_oem, '') like '%' || p.search_norm || '%'
      )
      and (
        p.integrity_filter in ('', 'all')
        or (p.integrity_filter = 'conflict' and i.status = 'conflict')
        or (p.integrity_filter = 'incomplete' and i.status = 'incomplete')
        or (p.integrity_filter = 'missing_ean' and coalesce(i.optional_missing_fields, array[]::text[]) @> array['ean']::text[])
        or (p.integrity_filter = 'pending' and coalesce(i.status, 'unknown') in ('unknown', 'queued', 'evaluating'))
        or (p.integrity_filter = 'failed' and i.status = 'failed')
      )
  ), page_rows as (
    select *
    from filtered
    order by product_code, id
    offset (select row_offset from params)
    limit (select page_size + 1 from params)
  ), page_marked as (
    select
      page_rows.*,
      row_number() over (order by product_code, id) as page_row_number
    from page_rows
  ), page_has_more as (
    select exists (
      select 1
      from page_marked
      where page_row_number > (select page_size from params)
    ) as has_more
  )
  select
    null::bigint as total_count,
    page_has_more.has_more,
    page_marked.id,
    page_marked.product_code,
    page_marked.brand,
    page_marked.image_url,
    page_marked.market_segment,
    page_marked.description,
    page_marked.oem_no,
    page_marked.vehicle,
    page_marked.hs_code,
    page_marked.origin,
    page_marked.weight_kg,
    page_marked.ean,
    page_marked.lifecycle_status,
    page_marked.lifecycle_note,
    page_marked.integrity_status,
    page_marked.critical_missing_fields,
    page_marked.optional_missing_fields,
    page_marked.conflict_fields,
    page_marked.pending_conflict_count,
    page_marked.last_evaluated_at,
    page_marked.integrity_last_error
  from page_marked
  cross join page_has_more
  where page_marked.page_row_number <= (select page_size from params)
  order by page_marked.product_code, page_marked.id;
$$;

revoke all on function public.cloud_catalog_integrity_page(text, text, text, text, integer, integer) from public;
grant execute on function public.cloud_catalog_integrity_page(text, text, text, text, integer, integer) to authenticated;

-- Fixed limits: backfill chunks are capped at 2,000 rows; worker claims are capped
-- at 250 rows. The runtime uses 1,000/100 by default to stay below Netlify and
-- Postgres statement timeouts while preserving set-based processing.
