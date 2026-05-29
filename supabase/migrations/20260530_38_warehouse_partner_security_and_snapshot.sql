alter table public.warehouse_api_clients
  add column if not exists allowed_ip_list text not null default '',
  add column if not exists require_hmac boolean not null default true,
  add column if not exists allow_order_submit boolean not null default false;

create table if not exists public.warehouse_stock_snapshots (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  warehouse_code text not null default '',
  warehouse_name text not null default '',
  brand text not null default '',
  brand_key text not null default '',
  product_code text not null default '',
  product_code_key text not null default '',
  old_code text not null default '',
  old_code_key text not null default '',
  description text not null default '',
  origin text not null default '',
  on_hand_qty numeric(18,2) not null default 0,
  available_qty numeric(18,2) not null default 0,
  stock_value numeric(18,2) not null default 0,
  average_cost numeric(18,4) not null default 0,
  last_moved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, warehouse_id, brand_key, product_code_key, old_code_key)
);

create index if not exists idx_warehouse_stock_snapshots_org_warehouse
  on public.warehouse_stock_snapshots (organization_id, warehouse_id, warehouse_name, brand);

create index if not exists idx_warehouse_stock_snapshots_org_code
  on public.warehouse_stock_snapshots (organization_id, product_code_key, old_code_key);

grant select, insert, update, delete
on public.warehouse_stock_snapshots
to authenticated;

grant select, insert, update, delete
on public.warehouse_stock_snapshots
to service_role;

alter table public.warehouse_stock_snapshots enable row level security;

drop policy if exists warehouse_stock_snapshots_select_admin on public.warehouse_stock_snapshots;
create policy warehouse_stock_snapshots_select_admin on public.warehouse_stock_snapshots
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_stock_snapshots_write_admin on public.warehouse_stock_snapshots;
create policy warehouse_stock_snapshots_write_admin on public.warehouse_stock_snapshots
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

create or replace function public.normalize_stock_snapshot_key(value text)
returns text
language sql
immutable
as $$
  select regexp_replace(upper(coalesce(value, '')), '[^A-Z0-9]+', '', 'g');
$$;

create or replace function public.refresh_warehouse_stock_snapshots(target_org_id uuid default null, target_warehouse_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_org_id is null and target_warehouse_id is null then
    delete from public.warehouse_stock_snapshots;
  elsif target_warehouse_id is not null then
    delete from public.warehouse_stock_snapshots
    where warehouse_id = target_warehouse_id
      and (target_org_id is null or organization_id = target_org_id);
  else
    delete from public.warehouse_stock_snapshots
    where organization_id = target_org_id;
  end if;

  insert into public.warehouse_stock_snapshots (
    organization_id,
    warehouse_id,
    warehouse_code,
    warehouse_name,
    brand,
    brand_key,
    product_code,
    product_code_key,
    old_code,
    old_code_key,
    description,
    origin,
    on_hand_qty,
    available_qty,
    stock_value,
    average_cost,
    last_moved_at,
    created_at,
    updated_at
  )
  select
    movement.organization_id,
    movement.warehouse_id,
    max(coalesce(movement.warehouse_code, '')) as warehouse_code,
    max(coalesce(movement.warehouse_name, '')) as warehouse_name,
    max(coalesce(movement.brand, '')) as brand,
    public.normalize_stock_snapshot_key(max(coalesce(movement.brand, ''))) as brand_key,
    max(coalesce(movement.product_code, '')) as product_code,
    public.normalize_stock_snapshot_key(max(coalesce(movement.product_code, ''))) as product_code_key,
    max(coalesce(movement.old_code, '')) as old_code,
    public.normalize_stock_snapshot_key(max(coalesce(movement.old_code, ''))) as old_code_key,
    coalesce((array_agg(nullif(movement.description, '') order by movement.moved_at desc) filter (where nullif(movement.description, '') is not null))[1], '') as description,
    coalesce((array_agg(nullif(movement.origin, '') order by movement.moved_at desc) filter (where nullif(movement.origin, '') is not null))[1], '') as origin,
    round(sum(coalesce(movement.qty_in, 0) - coalesce(movement.qty_out, 0))::numeric, 2) as on_hand_qty,
    round(sum(coalesce(movement.qty_in, 0) - coalesce(movement.qty_out, 0))::numeric, 2) as available_qty,
    round(sum(
      case
        when coalesce(movement.qty_in, 0) > 0 then coalesce(movement.total_cost, 0)
        else -coalesce(movement.total_cost, 0)
      end
    )::numeric, 2) as stock_value,
    round(
      case
        when sum(coalesce(movement.qty_in, 0) - coalesce(movement.qty_out, 0)) > 0
          then sum(
            case
              when coalesce(movement.qty_in, 0) > 0 then coalesce(movement.total_cost, 0)
              else -coalesce(movement.total_cost, 0)
            end
          ) / sum(coalesce(movement.qty_in, 0) - coalesce(movement.qty_out, 0))
        else 0
      end
    ::numeric, 4) as average_cost,
    max(movement.moved_at) as last_moved_at,
    now() as created_at,
    now() as updated_at
  from public.inventory_movements as movement
  where (target_org_id is null or movement.organization_id = target_org_id)
    and (target_warehouse_id is null or movement.warehouse_id = target_warehouse_id)
  group by
    movement.organization_id,
    movement.warehouse_id,
    public.normalize_stock_snapshot_key(coalesce(movement.brand, '')),
    public.normalize_stock_snapshot_key(coalesce(movement.product_code, '')),
    public.normalize_stock_snapshot_key(coalesce(movement.old_code, ''));
end;
$$;

create or replace function public.apply_inventory_movement_to_stock_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  qty_delta numeric := 0;
  value_delta numeric := 0;
  next_brand_key text := '';
  next_product_code_key text := '';
  next_old_code_key text := '';
begin
  if tg_op = 'INSERT' then
    qty_delta := round((coalesce(new.qty_in, 0) - coalesce(new.qty_out, 0))::numeric, 2);
    value_delta := round((
      case
        when coalesce(new.qty_in, 0) > 0 then coalesce(new.total_cost, 0)
        else -coalesce(new.total_cost, 0)
      end
    )::numeric, 2);
    next_brand_key := public.normalize_stock_snapshot_key(new.brand);
    next_product_code_key := public.normalize_stock_snapshot_key(new.product_code);
    next_old_code_key := public.normalize_stock_snapshot_key(new.old_code);

    insert into public.warehouse_stock_snapshots (
      organization_id,
      warehouse_id,
      warehouse_code,
      warehouse_name,
      brand,
      brand_key,
      product_code,
      product_code_key,
      old_code,
      old_code_key,
      description,
      origin,
      on_hand_qty,
      available_qty,
      stock_value,
      average_cost,
      last_moved_at,
      created_at,
      updated_at
    )
    values (
      new.organization_id,
      new.warehouse_id,
      coalesce(new.warehouse_code, ''),
      coalesce(new.warehouse_name, ''),
      coalesce(new.brand, ''),
      next_brand_key,
      coalesce(new.product_code, ''),
      next_product_code_key,
      coalesce(new.old_code, ''),
      next_old_code_key,
      coalesce(new.description, ''),
      coalesce(new.origin, ''),
      qty_delta,
      qty_delta,
      value_delta,
      case when qty_delta > 0 then round((value_delta / qty_delta)::numeric, 4) else 0 end,
      new.moved_at,
      now(),
      now()
    )
    on conflict (organization_id, warehouse_id, brand_key, product_code_key, old_code_key)
    do update set
      warehouse_code = excluded.warehouse_code,
      warehouse_name = excluded.warehouse_name,
      brand = case when warehouse_stock_snapshots.brand = '' then excluded.brand else warehouse_stock_snapshots.brand end,
      product_code = case when warehouse_stock_snapshots.product_code = '' then excluded.product_code else warehouse_stock_snapshots.product_code end,
      old_code = case when warehouse_stock_snapshots.old_code = '' then excluded.old_code else warehouse_stock_snapshots.old_code end,
      description = case when warehouse_stock_snapshots.description = '' then excluded.description else warehouse_stock_snapshots.description end,
      origin = case when warehouse_stock_snapshots.origin = '' then excluded.origin else warehouse_stock_snapshots.origin end,
      on_hand_qty = round((warehouse_stock_snapshots.on_hand_qty + excluded.on_hand_qty)::numeric, 2),
      available_qty = round((warehouse_stock_snapshots.available_qty + excluded.available_qty)::numeric, 2),
      stock_value = round((warehouse_stock_snapshots.stock_value + excluded.stock_value)::numeric, 2),
      average_cost = case
        when round((warehouse_stock_snapshots.on_hand_qty + excluded.on_hand_qty)::numeric, 2) > 0
          then round(((warehouse_stock_snapshots.stock_value + excluded.stock_value) / (warehouse_stock_snapshots.on_hand_qty + excluded.on_hand_qty))::numeric, 4)
        else 0
      end,
      last_moved_at = greatest(coalesce(warehouse_stock_snapshots.last_moved_at, excluded.last_moved_at), excluded.last_moved_at),
      updated_at = now();

    return new;
  end if;

  if tg_op = 'UPDATE' then
    perform public.refresh_warehouse_stock_snapshots(old.organization_id, old.warehouse_id);
    if new.warehouse_id is distinct from old.warehouse_id or new.organization_id is distinct from old.organization_id then
      perform public.refresh_warehouse_stock_snapshots(new.organization_id, new.warehouse_id);
    else
      perform public.refresh_warehouse_stock_snapshots(new.organization_id, new.warehouse_id);
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    perform public.refresh_warehouse_stock_snapshots(old.organization_id, old.warehouse_id);
    return old;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_inventory_movements_stock_snapshot on public.inventory_movements;
create trigger trg_inventory_movements_stock_snapshot
after insert or update or delete on public.inventory_movements
for each row
execute function public.apply_inventory_movement_to_stock_snapshot();

select public.refresh_warehouse_stock_snapshots();

create table if not exists public.warehouse_api_order_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid references public.warehouse_api_clients(id) on delete set null,
  client_name text not null default '',
  partner_name text not null default '',
  request_no text not null default '',
  status text not null default 'submitted',
  buyer_reference text not null default '',
  requested_currency text not null default 'EUR',
  requested_delivery_date date,
  ship_to_name text not null default '',
  ship_to_address text not null default '',
  contact_name text not null default '',
  contact_email text not null default '',
  contact_phone text not null default '',
  notes text not null default '',
  lines jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_api_order_requests'::regclass
      and conname = 'warehouse_api_order_requests_status_check'
  ) then
    alter table public.warehouse_api_order_requests
      add constraint warehouse_api_order_requests_status_check
      check (status in ('submitted', 'accepted', 'rejected', 'cancelled'));
  end if;
end $$;

create index if not exists idx_warehouse_api_order_requests_org_created
  on public.warehouse_api_order_requests (organization_id, created_at desc);

grant select, insert, update, delete
on public.warehouse_api_order_requests
to authenticated;

grant select, insert, update, delete
on public.warehouse_api_order_requests
to service_role;

alter table public.warehouse_api_order_requests enable row level security;

drop policy if exists warehouse_api_order_requests_select_admin on public.warehouse_api_order_requests;
create policy warehouse_api_order_requests_select_admin on public.warehouse_api_order_requests
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouse_api_order_requests_write_admin on public.warehouse_api_order_requests;
create policy warehouse_api_order_requests_write_admin on public.warehouse_api_order_requests
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

alter table public.warehouse_api_request_logs
  add column if not exists request_kind text not null default 'stock_feed';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouse_api_request_logs'::regclass
      and conname = 'warehouse_api_request_logs_kind_check'
  ) then
    alter table public.warehouse_api_request_logs
      add constraint warehouse_api_request_logs_kind_check
      check (request_kind in ('stock_feed', 'order_submit'));
  end if;
end $$;
