-- Retain supplier-price history for six months after a price row is replaced.
-- A row becomes passive only after a successful finalized replace import. The
-- deactivation timestamp is captured by a trigger so every import path uses
-- the same retention clock.

alter table public.supplier_prices
  add column if not exists deactivated_at timestamptz;

-- Existing passive rows are backfilled in bounded batches after this DDL is
-- applied. This avoids holding a long migration lock on the live price table.

create or replace function public.set_supplier_price_deactivated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'INSERT' then
    new.deactivated_at := case when new.is_active then null else coalesce(new.deactivated_at, clock_timestamp()) end;
    return new;
  end if;

  if new.is_active and not old.is_active then
    new.deactivated_at := null;
  elsif not new.is_active and (old.is_active or old.deactivated_at is null) then
    new.deactivated_at := coalesce(old.deactivated_at, clock_timestamp());
  end if;

  return new;
end;
$function$;

drop trigger if exists supplier_prices_deactivated_at on public.supplier_prices;
create trigger supplier_prices_deactivated_at
before insert or update of is_active on public.supplier_prices
for each row execute function public.set_supplier_price_deactivated_at();

revoke all on function public.set_supplier_price_deactivated_at() from public, anon, authenticated;

-- Delete only rows that are still passive and have been passive for six full
-- months. The bounded batch keeps the operation below the import timeout and
-- allows the scheduled worker to resume safely.
create or replace function public.purge_inactive_supplier_prices(input_batch_size integer default 5000)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '50s'
as $function$
declare
  v_batch_size integer := greatest(100, least(coalesce(input_batch_size, 5000), 5000));
  v_cutoff timestamptz := clock_timestamp() - interval '6 months';
  v_deleted integer := 0;
  v_remaining bigint := 0;
begin
  with doomed as (
    select id
    from public.supplier_prices
    where is_active = false
      and (
        (deactivated_at is not null and deactivated_at < v_cutoff)
        or (deactivated_at is null and coalesce(updated_at, created_at) < v_cutoff)
      )
    order by deactivated_at, id
    limit v_batch_size
  ), deleted as (
    delete from public.supplier_prices sp
    using doomed
    where sp.id = doomed.id
      and sp.is_active = false
      and (
        (sp.deactivated_at is not null and sp.deactivated_at < v_cutoff)
        or (sp.deactivated_at is null and coalesce(sp.updated_at, sp.created_at) < v_cutoff)
      )
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;

  select count(*)::bigint into v_remaining
  from public.supplier_prices
  where is_active = false
    and (
      (deactivated_at is not null and deactivated_at < v_cutoff)
      or (deactivated_at is null and coalesce(updated_at, created_at) < v_cutoff)
    );

  return jsonb_build_object(
    'status', 'ok',
    'deleted', v_deleted,
    'remaining', v_remaining,
    'retention_months', 6,
    'cutoff', v_cutoff
  );
end;
$function$;

revoke all on function public.purge_inactive_supplier_prices(integer) from public, anon, authenticated;
grant execute on function public.purge_inactive_supplier_prices(integer) to service_role;
