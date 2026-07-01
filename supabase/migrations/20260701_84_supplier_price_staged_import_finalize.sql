-- Supplier price imports now support retry-safe Replace semantics.
-- Chunks are staged outside operational supplier_prices first. Finalize applies
-- Replace/Merge in one transaction, so a failed upload leaves the old active
-- supplier+brand list untouched.

create table if not exists public.supplier_price_import_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  mode text not null,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error_message text,
  staged_rows integer not null default 0,
  processed_rows integer,
  catalog_synced integer,
  created_by uuid default auth.uid(),
  constraint supplier_price_import_runs_mode_check
    check (mode in ('replace', 'merge')),
  constraint supplier_price_import_runs_status_check
    check (status in ('running', 'finalizing', 'succeeded', 'failed'))
);

create table if not exists public.supplier_price_import_stage (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.supplier_price_import_runs(id) on delete cascade,
  organization_id uuid not null,
  supplier_id uuid not null,
  brand_id uuid not null,
  product_code text not null,
  description text,
  oem_no text,
  buy_price numeric,
  currency text not null default 'EUR',
  moq integer,
  lead_time_days integer,
  notes text,
  valid_from date not null default current_date,
  normalized_code text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_supplier_price_import_runs_org_started
  on public.supplier_price_import_runs (organization_id, started_at desc);

create index if not exists idx_supplier_price_import_runs_scope_status
  on public.supplier_price_import_runs (organization_id, supplier_id, brand_id, status, started_at desc);

create index if not exists idx_supplier_price_import_stage_run
  on public.supplier_price_import_stage (run_id);

create index if not exists idx_supplier_price_import_stage_run_code_date
  on public.supplier_price_import_stage (run_id, normalized_code, valid_from);

alter table public.supplier_price_import_runs enable row level security;
alter table public.supplier_price_import_stage enable row level security;

drop policy if exists supplier_price_import_runs_select_superadmin
on public.supplier_price_import_runs;

create policy supplier_price_import_runs_select_superadmin
on public.supplier_price_import_runs
for select
using (public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists supplier_price_import_stage_select_superadmin
on public.supplier_price_import_stage;

create policy supplier_price_import_stage_select_superadmin
on public.supplier_price_import_stage
for select
using (public.is_superadmin() and organization_id = public.current_profile_org_id());

grant select on public.supplier_price_import_runs to authenticated;
grant select on public.supplier_price_import_stage to authenticated;

drop function if exists public.begin_supplier_price_import(text, text, text);

create or replace function public.begin_supplier_price_import(
  input_supplier_name text,
  input_brand text,
  input_mode text default 'replace'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_supplier_name text := nullif(trim(coalesce(input_supplier_name, '')), '');
  v_brand_name text := nullif(trim(coalesce(input_brand, '')), '');
  v_mode text := lower(nullif(trim(coalesce(input_mode, '')), ''));
  v_supplier_id uuid;
  v_brand_id uuid;
  v_run_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import supplier prices';
  end if;

  if v_supplier_name is null then
    raise exception 'Supplier is required';
  end if;

  if v_brand_name is null then
    raise exception 'Brand is required';
  end if;

  if v_mode not in ('replace', 'merge') then
    raise exception 'Import mode must be replace or merge';
  end if;

  insert into public.suppliers (organization_id, name)
  values (v_org_id, v_supplier_name)
  on conflict (organization_id, normalized_name) do nothing;

  select s.id
  into v_supplier_id
  from public.suppliers s
  where s.organization_id = v_org_id
    and s.normalized_name = public.normalize_part_code(v_supplier_name)
  limit 1;

  insert into public.brands (organization_id, name)
  values (v_org_id, coalesce(v_brand_name, 'Unbranded'))
  on conflict (organization_id, normalized_name) do nothing;

  select b.id
  into v_brand_id
  from public.brands b
  where b.organization_id = v_org_id
    and b.normalized_name = public.normalize_part_code(coalesce(v_brand_name, 'Unbranded'))
  limit 1;

  if v_supplier_id is null or v_brand_id is null then
    raise exception 'Supplier or brand could not be resolved';
  end if;

  insert into public.supplier_price_import_runs (
    organization_id,
    supplier_id,
    brand_id,
    mode,
    status
  )
  values (
    v_org_id,
    v_supplier_id,
    v_brand_id,
    v_mode,
    'running'
  )
  returning id into v_run_id;

  return jsonb_build_object(
    'status', 'running',
    'run_id', v_run_id,
    'organization_id', v_org_id,
    'supplier_id', v_supplier_id,
    'brand_id', v_brand_id,
    'mode', v_mode
  );
end;
$$;

grant execute on function public.begin_supplier_price_import(text, text, text) to authenticated;

drop function if exists public.stage_supplier_price_import_chunk(uuid, jsonb);

create or replace function public.stage_supplier_price_import_chunk(
  input_run_id uuid,
  payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_run public.supplier_price_import_runs%rowtype;
  v_inserted integer := 0;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import supplier prices';
  end if;

  if input_run_id is null then
    raise exception 'Import run is required';
  end if;

  select *
  into v_run
  from public.supplier_price_import_runs
  where id = input_run_id
    and organization_id = v_org_id
  for update;

  if not found then
    raise exception 'Import run was not found';
  end if;

  if v_run.status <> 'running' then
    raise exception 'Import run is not accepting chunks';
  end if;

  create temporary table tmp_supplier_price_import_stage (
    product_code text,
    description text,
    oem_no text,
    buy_price numeric,
    currency text,
    moq integer,
    lead_time_days integer,
    notes text,
    valid_from date
  ) on commit drop;

  insert into tmp_supplier_price_import_stage (
    product_code,
    description,
    oem_no,
    buy_price,
    currency,
    moq,
    lead_time_days,
    notes,
    valid_from
  )
  select
    nullif(trim(coalesce(product_code, '')), ''),
    nullif(trim(coalesce(description, '')), ''),
    nullif(trim(coalesce(oem_no, '')), ''),
    buy_price,
    coalesce(nullif(trim(currency), ''), 'EUR'),
    moq,
    lead_time_days,
    nullif(trim(coalesce(notes, '')), ''),
    coalesce(valid_from, current_date)
  from jsonb_to_recordset(payload) as x(
    supplier_name text,
    brand text,
    product_code text,
    description text,
    oem_no text,
    buy_price numeric,
    currency text,
    moq integer,
    lead_time_days integer,
    notes text,
    valid_from date
  )
  where public.normalize_part_code(product_code) <> '';

  insert into public.supplier_price_import_stage (
    run_id,
    organization_id,
    supplier_id,
    brand_id,
    product_code,
    description,
    oem_no,
    buy_price,
    currency,
    moq,
    lead_time_days,
    notes,
    valid_from,
    normalized_code
  )
  select
    v_run.id,
    v_run.organization_id,
    v_run.supplier_id,
    v_run.brand_id,
    t.product_code,
    t.description,
    t.oem_no,
    round(coalesce(t.buy_price, 0), 2),
    t.currency,
    t.moq,
    t.lead_time_days,
    t.notes,
    t.valid_from,
    public.normalize_part_code(t.product_code)
  from tmp_supplier_price_import_stage t
  where public.normalize_part_code(t.product_code) <> '';

  get diagnostics v_inserted = row_count;

  update public.supplier_price_import_runs
  set staged_rows = staged_rows + v_inserted
  where id = v_run.id;

  return jsonb_build_object(
    'status', 'ok',
    'processed', v_inserted,
    'staged_rows', v_run.staged_rows + v_inserted
  );
end;
$$;

grant execute on function public.stage_supplier_price_import_chunk(uuid, jsonb) to authenticated;

drop function if exists public.finalize_supplier_price_import(uuid);

create or replace function public.finalize_supplier_price_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_org_id uuid;
  v_run public.supplier_price_import_runs%rowtype;
  v_processed integer := 0;
  v_catalog_synced integer := 0;
  v_deactivated integer := 0;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import supplier prices';
  end if;

  if input_run_id is null then
    raise exception 'Import run is required';
  end if;

  select *
  into v_run
  from public.supplier_price_import_runs
  where id = input_run_id
    and organization_id = v_org_id
  for update;

  if not found then
    raise exception 'Import run was not found';
  end if;

  if v_run.status <> 'running' then
    raise exception 'Import run cannot be finalized from status %', v_run.status;
  end if;

  if v_run.staged_rows <= 0 then
    raise exception 'Import run has no staged rows';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      v_run.organization_id::text || ':' || v_run.supplier_id::text || ':' || v_run.brand_id::text,
      0
    )
  );

  begin
    update public.supplier_price_import_runs
    set status = 'finalizing'
    where id = v_run.id;

    if v_run.mode = 'replace' then
      update public.supplier_prices sp
      set is_active = false,
          updated_at = now()
      where sp.organization_id = v_run.organization_id
        and sp.supplier_id = v_run.supplier_id
        and sp.brand_id = v_run.brand_id
        and sp.is_active;

      get diagnostics v_deactivated = row_count;
    end if;

    with supplier_source_rows as (
      select distinct on (
        s.supplier_id,
        s.brand_id,
        s.normalized_code,
        s.valid_from
      )
        s.organization_id,
        s.supplier_id,
        s.brand_id,
        s.product_code,
        s.description,
        s.oem_no,
        round(coalesce(s.buy_price, 0), 2) as buy_price,
        s.currency,
        s.moq,
        s.lead_time_days,
        s.notes,
        s.valid_from,
        s.normalized_code
      from public.supplier_price_import_stage s
      where s.run_id = v_run.id
        and s.organization_id = v_run.organization_id
        and s.supplier_id = v_run.supplier_id
        and s.brand_id = v_run.brand_id
        and s.normalized_code <> ''
      order by
        s.supplier_id,
        s.brand_id,
        s.normalized_code,
        s.valid_from,
        case when s.buy_price is not null and s.buy_price > 0 then 0 else 1 end,
        case when nullif(trim(coalesce(s.description, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.oem_no, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.notes, '')), '') is not null then 0 else 1 end,
        s.buy_price asc nulls last,
        s.id
    ),
    duplicate_stats as (
      select
        greatest(
          (select count(*) from public.supplier_price_import_stage where run_id = v_run.id)
          - (select count(*) from supplier_source_rows),
          0
        )::integer as duplicate_rows
    ),
    upserted_supplier_prices as (
      insert into public.supplier_prices (
        organization_id,
        supplier_id,
        brand_id,
        product_code,
        description,
        oem_no,
        buy_price,
        currency,
        moq,
        lead_time_days,
        notes,
        valid_from,
        is_active
      )
      select
        organization_id,
        supplier_id,
        brand_id,
        product_code,
        description,
        oem_no,
        buy_price,
        currency,
        moq,
        lead_time_days,
        notes,
        valid_from,
        true
      from supplier_source_rows
      on conflict (organization_id, supplier_id, brand_id, normalized_code, valid_from) do update set
        product_code = excluded.product_code,
        description = coalesce(excluded.description, public.supplier_prices.description),
        oem_no = coalesce(excluded.oem_no, public.supplier_prices.oem_no),
        buy_price = excluded.buy_price,
        currency = excluded.currency,
        moq = coalesce(excluded.moq, public.supplier_prices.moq),
        lead_time_days = coalesce(excluded.lead_time_days, public.supplier_prices.lead_time_days),
        notes = coalesce(excluded.notes, public.supplier_prices.notes),
        is_active = true,
        updated_at = now()
      where
        public.supplier_prices.product_code is distinct from excluded.product_code
        or (excluded.description is not null and public.supplier_prices.description is distinct from excluded.description)
        or (excluded.oem_no is not null and public.supplier_prices.oem_no is distinct from excluded.oem_no)
        or public.supplier_prices.buy_price is distinct from excluded.buy_price
        or public.supplier_prices.currency is distinct from excluded.currency
        or (excluded.moq is not null and public.supplier_prices.moq is distinct from excluded.moq)
        or (excluded.lead_time_days is not null and public.supplier_prices.lead_time_days is distinct from excluded.lead_time_days)
        or (excluded.notes is not null and public.supplier_prices.notes is distinct from excluded.notes)
        or public.supplier_prices.is_active is distinct from true
      returning 1
    )
    select count(*)::integer into v_processed
    from upserted_supplier_prices;

    with source_rows as (
      select distinct on (s.brand_id, s.normalized_code)
        s.organization_id,
        s.brand_id,
        s.product_code,
        s.description,
        s.oem_no,
        s.notes,
        s.normalized_code
      from public.supplier_price_import_stage s
      where s.run_id = v_run.id
        and s.organization_id = v_run.organization_id
        and s.brand_id = v_run.brand_id
        and s.normalized_code <> ''
      order by
        s.brand_id,
        s.normalized_code,
        case when nullif(trim(coalesce(s.description, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.oem_no, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.notes, '')), '') is not null then 0 else 1 end,
        s.buy_price asc nulls last,
        s.valid_from desc nulls last,
        s.id
    ),
    upserted_catalog as (
      insert into public.catalog_products (
        organization_id,
        brand_id,
        product_code,
        description,
        oem_no,
        notes
      )
      select
        organization_id,
        brand_id,
        product_code,
        nullif(trim(coalesce(description, '')), ''),
        nullif(trim(coalesce(oem_no, '')), ''),
        nullif(trim(coalesce(notes, '')), '')
      from source_rows
      on conflict (organization_id, brand_id, normalized_code) do update set
        product_code = excluded.product_code,
        description = case
          when nullif(trim(coalesce(public.catalog_products.description, '')), '') is null
            then excluded.description
          else public.catalog_products.description
        end,
        oem_no = case
          when nullif(trim(coalesce(public.catalog_products.oem_no, '')), '') is null
            then excluded.oem_no
          else public.catalog_products.oem_no
        end,
        notes = case
          when nullif(trim(coalesce(public.catalog_products.notes, '')), '') is null
            then excluded.notes
          else public.catalog_products.notes
        end,
        updated_at = now()
      where
        public.catalog_products.product_code is distinct from excluded.product_code
        or (
          nullif(trim(coalesce(public.catalog_products.description, '')), '') is null
          and excluded.description is not null
        )
        or (
          nullif(trim(coalesce(public.catalog_products.oem_no, '')), '') is null
          and excluded.oem_no is not null
        )
        or (
          nullif(trim(coalesce(public.catalog_products.notes, '')), '') is null
          and excluded.notes is not null
        )
      returning 1
    )
    select count(*)::integer into v_catalog_synced
    from upserted_catalog;

    update public.supplier_price_import_runs
    set status = 'succeeded',
        finished_at = now(),
        error_message = null,
        processed_rows = v_processed,
        catalog_synced = v_catalog_synced
    where id = v_run.id;

    return jsonb_build_object(
      'status', 'ok',
      'run_id', v_run.id,
      'mode', v_run.mode,
      'processed', v_processed,
      'catalog_synced', v_catalog_synced,
      'deactivated', v_deactivated,
      'staged_rows', v_run.staged_rows
    );
  exception
    when others then
      update public.supplier_price_import_runs
      set status = 'failed',
          finished_at = now(),
          error_message = sqlerrm
      where id = v_run.id;
      raise;
  end;
end;
$$;

grant execute on function public.finalize_supplier_price_import(uuid) to authenticated;

drop function if exists public.fail_supplier_price_import(uuid, text);

create or replace function public.fail_supplier_price_import(
  input_run_id uuid,
  input_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_run_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import supplier prices';
  end if;

  update public.supplier_price_import_runs
  set status = 'failed',
      finished_at = now(),
      error_message = nullif(trim(coalesce(input_error_message, '')), '')
  where id = input_run_id
    and organization_id = v_org_id
    and status in ('running', 'finalizing')
  returning id into v_run_id;

  if v_run_id is null then
    raise exception 'Import run was not found or cannot be failed';
  end if;

  return jsonb_build_object(
    'status', 'failed',
    'run_id', v_run_id
  );
end;
$$;

grant execute on function public.fail_supplier_price_import(uuid, text) to authenticated;
