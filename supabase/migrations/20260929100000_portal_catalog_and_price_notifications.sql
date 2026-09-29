-- Announce completed catalog imports and price-list catalog syncs to portal users.

create or replace function public.notify_portal_catalog_import_finalized()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand_id uuid;
  v_brand_name text;
  v_brand_label text := nullif(trim(coalesce(NEW.input_scope ->> 'brand', '')), '');
begin
  if NEW.status <> 'finalized' or OLD.status is not distinct from NEW.status or v_brand_label is null then
    return NEW;
  end if;
  select b.id, b.name into v_brand_id, v_brand_name
  from public.brands b
  where b.organization_id = NEW.organization_id
    and (lower(trim(b.name)) = lower(v_brand_label)
      or lower(trim(coalesce(b.normalized_name, ''))) = lower(v_brand_label))
  order by b.created_at nulls last limit 1;
  if v_brand_id is null then return NEW; end if;

  insert into public.portal_audit_logs (organization_id, invite_id, party_type, email, event_type, status, details)
  select NEW.organization_id, i.id, i.party_type, i.email, 'portal_catalog_updated', 'ok',
    jsonb_build_object(
      'run_id', NEW.id, 'brand_id', v_brand_id, 'brand_name', v_brand_name,
      'staged_rows', coalesce(NEW.staged_rows, 0), 'processed_rows', coalesce(NEW.processed_rows, 0),
      'inserted_count', coalesce(NEW.inserted_count, 0), 'updated_count', coalesce(NEW.updated_count, 0),
      'message', format('New catalog data for %s is now available in your customer portal.', coalesce(v_brand_name, v_brand_label)))
  from public.portal_invites i
  where i.organization_id = NEW.organization_id and i.status = 'active' and i.customer_id is not null
    and (coalesce(i.allowed_brand_ids, '[]'::jsonb) = '[]'::jsonb
      or coalesce(i.allowed_brand_ids, '[]'::jsonb) @> jsonb_build_array(v_brand_id::text))
    and not exists (
      select 1 from public.portal_audit_logs existing
      where existing.invite_id = i.id and existing.event_type = 'portal_catalog_updated'
        and existing.details ->> 'run_id' = NEW.id::text);
  return NEW;
end;
$$;

revoke all on function public.notify_portal_catalog_import_finalized() from public, anon, authenticated;
drop trigger if exists portal_catalog_import_finalized_notification on public.catalog_import_runs;
create trigger portal_catalog_import_finalized_notification
after update of status on public.catalog_import_runs
for each row execute function public.notify_portal_catalog_import_finalized();

create or replace function public.notify_portal_price_list_finalized()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand_name text;
  v_supplier_name text;
  v_should_notify boolean;
begin
  v_should_notify :=
    (NEW.status in ('finalized', 'succeeded') and OLD.status is distinct from NEW.status)
    or (NEW.catalog_sync_status = 'succeeded' and OLD.catalog_sync_status is distinct from NEW.catalog_sync_status);
  if not v_should_notify then return NEW; end if;

  select b.name, s.name into v_brand_name, v_supplier_name
  from public.brands b join public.suppliers s on s.id = NEW.supplier_id and s.organization_id = NEW.organization_id
  where b.id = NEW.brand_id and b.organization_id = NEW.organization_id;

  insert into public.portal_audit_logs (organization_id, invite_id, party_type, email, event_type, status, details)
  select NEW.organization_id, i.id, i.party_type, i.email, 'portal_price_list_updated', 'ok',
    jsonb_build_object(
      'run_id', NEW.id, 'brand_id', NEW.brand_id, 'brand_name', v_brand_name,
      'supplier_id', NEW.supplier_id, 'supplier_name', v_supplier_name,
      'staged_rows', coalesce(NEW.staged_rows, 0), 'processed_rows', coalesce(NEW.processed_rows, 0),
      'message', format('The %s price list for %s is now available in your customer portal.', coalesce(v_brand_name, 'catalog'), coalesce(v_supplier_name, 'supplier')))
  from public.portal_invites i
  where i.organization_id = NEW.organization_id and i.status = 'active' and i.customer_id is not null
    and (coalesce(i.allowed_brand_ids, '[]'::jsonb) = '[]'::jsonb
      or coalesce(i.allowed_brand_ids, '[]'::jsonb) @> jsonb_build_array(NEW.brand_id::text))
    and not exists (
      select 1 from public.portal_audit_logs existing
      where existing.invite_id = i.id and existing.event_type = 'portal_price_list_updated'
        and existing.details ->> 'run_id' = NEW.id::text);
  return NEW;
end;
$$;

revoke all on function public.notify_portal_price_list_finalized() from public, anon, authenticated;
drop trigger if exists portal_price_list_catalog_sync_notification on public.supplier_price_import_runs;
create trigger portal_price_list_catalog_sync_notification
after update of catalog_sync_status on public.supplier_price_import_runs
for each row execute function public.notify_portal_price_list_finalized();
