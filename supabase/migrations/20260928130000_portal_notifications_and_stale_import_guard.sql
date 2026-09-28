-- Operational guardrails for supplier imports and customer portal announcements.
-- Stale workers are closed before a new import begins; CSV brand identity is
-- checked again at the database boundary; catalog and finalized price-list
-- events are fanned out to active portal invites.

create or replace function public.close_stale_supplier_price_import_runs(
  input_age interval default interval '2 hours'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed integer;
begin
  update public.supplier_price_import_runs
  set status = 'failed',
      finished_at = coalesce(finished_at, now()),
      error_message = coalesce(error_message, 'Automatically closed as stale: no progress for more than 2 hours.'),
      catalog_sync_status = case
        when catalog_sync_status in ('pending', 'running') then 'failed'
        else catalog_sync_status
      end,
      catalog_sync_finished_at = coalesce(catalog_sync_finished_at, now()),
      catalog_sync_error_message = coalesce(catalog_sync_error_message, 'Automatically closed as stale: no progress for more than 2 hours.'),
      catalog_sync_worker_state = 'failed',
      processing_queued_at = null,
      processing_queued_by = null
  where status in ('running', 'finalizing')
    and started_at < now() - coalesce(input_age, interval '2 hours');

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

revoke all on function public.close_stale_supplier_price_import_runs(interval) from public;
grant execute on function public.close_stale_supplier_price_import_runs(interval) to authenticated;

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
begin
  if public.current_profile_org_id() is null
     or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  perform public.close_stale_supplier_price_import_runs(interval '2 hours');
  return public.begin_supplier_price_import_inner(input_supplier_name, input_brand, input_mode);
end;
$$;

grant execute on function public.begin_supplier_price_import(text, text, text) to authenticated;

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
  result jsonb;
  v_expected_brand text;
  v_brand_count integer := 0;
  v_mismatch text;
begin
  if public.current_profile_org_id() is null
     or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  -- Payloads from older clients may omit Brand; those remain compatible. If
  -- Brand is present, reject mixed files and selected-brand mismatches before
  -- any row reaches the staging table.
  select b.name
    into v_expected_brand
  from public.supplier_price_import_runs r
  join public.brands b on b.id = r.brand_id and b.organization_id = r.organization_id
  where r.id = input_run_id
    and r.organization_id = public.current_profile_org_id();

  select count(distinct public.normalize_part_code(nullif(trim(coalesce(rows.brand, '')), '')))
    into v_brand_count
  from jsonb_to_recordset(payload) as rows(brand text)
  where nullif(trim(coalesce(rows.brand, '')), '') is not null;

  if v_brand_count > 1 then
    raise exception 'CSV contains multiple brands; upload one brand per import.';
  end if;

  if v_expected_brand is not null then
    select string_agg(brand_name, ', ' order by brand_name)
      into v_mismatch
    from (
      select distinct nullif(trim(coalesce(rows.brand, '')), '') as brand_name
      from jsonb_to_recordset(payload) as rows(brand text)
      where nullif(trim(coalesce(rows.brand, '')), '') is not null
        and public.normalize_part_code(rows.brand) <> public.normalize_part_code(v_expected_brand)
    ) mismatches;

    if v_mismatch is not null then
      raise exception 'CSV brand does not match selected import brand (% vs %).', v_mismatch, v_expected_brand;
    end if;
  end if;

  result := public.stage_supplier_price_import_chunk_inner(input_run_id, payload);

  update public.supplier_price_import_stage stage
  set ean = nullif(trim(rows.ean), ''),
      vehicle = nullif(trim(rows.vehicle), ''),
      vehicle_model = nullif(trim(rows.vehicle_model), ''),
      market_segment = nullif(trim(rows.market_segment), ''),
      weight_kg = rows.weight_kg,
      description_tr = nullif(trim(rows.description_tr), ''),
      origin = nullif(trim(rows.origin), '')
  from (
    select distinct on (public.normalize_part_code(product_code), coalesce(valid_from, current_date))
      product_code,
      valid_from,
      ean,
      vehicle,
      vehicle_model,
      market_segment,
      weight_kg,
      description_tr,
      origin
    from jsonb_to_recordset(payload) as input_rows(
      product_code text,
      valid_from date,
      ean text,
      vehicle text,
      vehicle_model text,
      market_segment text,
      weight_kg numeric,
      description_tr text,
      origin text
    )
    order by
      public.normalize_part_code(product_code),
      coalesce(valid_from, current_date),
      case when nullif(trim(coalesce(ean, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(description_tr, '')), '') is not null then 0 else 1 end
  ) rows
  where stage.run_id = input_run_id
    and stage.normalized_code = public.normalize_part_code(rows.product_code)
    and stage.valid_from = coalesce(rows.valid_from, current_date);

  return result;
end;
$$;

grant execute on function public.stage_supplier_price_import_chunk(uuid, jsonb) to authenticated;

create or replace function public.notify_portal_brand_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.portal_audit_logs (
    organization_id, invite_id, party_type, email, event_type, status, details
  )
  select
    NEW.organization_id,
    i.id,
    i.party_type,
    i.email,
    'portal_catalog_brand_added',
    'ok',
    jsonb_build_object(
      'brand_id', NEW.id,
      'brand_name', NEW.name,
      'message', format('New catalog brand %s is now available in your customer portal.', NEW.name)
    )
  from public.portal_invites i
  where i.organization_id = NEW.organization_id
    and i.status = 'active'
    and i.customer_id is not null
    and (
      coalesce(i.allowed_brand_ids, '[]'::jsonb) = '[]'::jsonb
      or coalesce(i.allowed_brand_ids, '[]'::jsonb) @> jsonb_build_array(NEW.id::text)
    )
    and not exists (
      select 1
      from public.portal_audit_logs existing
      where existing.invite_id = i.id
        and existing.event_type = 'portal_catalog_brand_added'
        and existing.details ->> 'brand_id' = NEW.id::text
    );

  return NEW;
end;
$$;

create or replace function public.notify_portal_price_list_finalized()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand_name text;
  v_supplier_name text;
begin
  if NEW.status not in ('finalized', 'succeeded')
     or OLD.status is not distinct from NEW.status then
    return NEW;
  end if;

  select b.name, s.name
    into v_brand_name, v_supplier_name
  from public.brands b
  join public.suppliers s on s.id = NEW.supplier_id and s.organization_id = NEW.organization_id
  where b.id = NEW.brand_id and b.organization_id = NEW.organization_id;

  insert into public.portal_audit_logs (
    organization_id, invite_id, party_type, email, event_type, status, details
  )
  select
    NEW.organization_id,
    i.id,
    i.party_type,
    i.email,
    'portal_price_list_updated',
    'ok',
    jsonb_build_object(
      'run_id', NEW.id,
      'brand_id', NEW.brand_id,
      'brand_name', v_brand_name,
      'supplier_id', NEW.supplier_id,
      'supplier_name', v_supplier_name,
      'staged_rows', coalesce(NEW.staged_rows, 0),
      'processed_rows', coalesce(NEW.processed_rows, 0),
      'message', format('The %s price list for %s is now available in your customer portal.', coalesce(v_brand_name, 'catalog'), coalesce(v_supplier_name, 'supplier'))
    )
  from public.portal_invites i
  where i.organization_id = NEW.organization_id
    and i.status = 'active'
    and i.customer_id is not null
    and (
      coalesce(i.allowed_brand_ids, '[]'::jsonb) = '[]'::jsonb
      or coalesce(i.allowed_brand_ids, '[]'::jsonb) @> jsonb_build_array(NEW.brand_id::text)
    )
    and not exists (
      select 1
      from public.portal_audit_logs existing
      where existing.invite_id = i.id
        and existing.event_type = 'portal_price_list_updated'
        and existing.details ->> 'run_id' = NEW.id::text
    );

  return NEW;
end;
$$;

drop trigger if exists portal_brand_added_notification on public.brands;
create trigger portal_brand_added_notification
after insert on public.brands
for each row execute function public.notify_portal_brand_added();

drop trigger if exists portal_price_list_finalized_notification on public.supplier_price_import_runs;
create trigger portal_price_list_finalized_notification
after update of status on public.supplier_price_import_runs
for each row execute function public.notify_portal_price_list_finalized();
