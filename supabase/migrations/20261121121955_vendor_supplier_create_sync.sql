-- Creating a vendor and its supplier-price identity must succeed or fail as
-- one transaction. Existing vendor/supplier rows, prices, and orders are not
-- backfilled, renamed, merged, or otherwise changed.
create schema if not exists vendor_supplier_sync_private;
revoke all on schema vendor_supplier_sync_private from public, anon, authenticated;

create or replace function vendor_supplier_sync_private.ensure_supplier_for_new_vendor()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text := coalesce(nullif(btrim(new.display_name), ''), nullif(btrim(new.company_name), ''), nullif(btrim(concat_ws(' ', new.first_name, new.last_name)), ''));
  v_normalized text;
  v_supplier_name text;
  v_supplier_id uuid;
begin
  v_normalized := public.normalize_part_code(v_name);
  if v_name is null or v_normalized = '' then
    raise exception 'A vendor name containing letters or digits is required for supplier prices' using errcode = '22023';
  end if;

  -- Vendor names are not protected by a DB unique constraint. Serialize
  -- same-organization/name inserts without blocking other suppliers.
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || v_normalized, 0));

  if exists (
    select 1 from public.vendors v
    where v.organization_id = new.organization_id and v.id <> new.id
      and public.normalize_part_code(coalesce(nullif(btrim(v.display_name), ''), nullif(btrim(v.company_name), ''), concat_ws(' ',v.first_name,v.last_name))) = v_normalized
  ) then
    raise exception 'A vendor with the same supplier identity already exists; review the names before saving' using errcode = '23505';
  end if;

  select s.id, s.name into v_supplier_id, v_supplier_name
  from public.suppliers s
  where s.organization_id = new.organization_id and s.normalized_name = v_normalized;
  if v_supplier_id is not null then
    if lower(btrim(v_supplier_name)) <> lower(btrim(v_name)) then
      raise exception 'A supplier with a similar name already exists; review the names before saving' using errcode = '23505';
    end if;
    return new;
  end if;

  insert into public.suppliers (organization_id, name)
  values (new.organization_id, v_name)
  on conflict (organization_id, normalized_name) do nothing
  returning id into v_supplier_id;
  if v_supplier_id is null then
    -- A concurrent insertion was not visible at the start of this statement;
    -- do not guess whether that supplier is the same business.
    raise exception 'Supplier identity changed concurrently; refresh and retry' using errcode = '40001';
  end if;
  return new;
end;
$$;

revoke all on function vendor_supplier_sync_private.ensure_supplier_for_new_vendor() from public, anon, authenticated;
drop trigger if exists vendor_supplier_create_sync on public.vendors;
create trigger vendor_supplier_create_sync after insert on public.vendors
for each row execute function vendor_supplier_sync_private.ensure_supplier_for_new_vendor();
