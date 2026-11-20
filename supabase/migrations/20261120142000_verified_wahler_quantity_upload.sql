-- A marked file is the original upload. Register its derived tier rows before
-- handing it to the normal validation queue, then seal them in the validation
-- transaction alongside the base rows. Existing releases have no new requirement.
create table supplier_price_ingestion_internal.pending_wahler_quantity_sources (
  release_id uuid primary key references public.supplier_price_releases(id) on delete cascade,
  original_sha256 text not null,
  rows jsonb not null
);
alter table supplier_price_ingestion_internal.pending_wahler_quantity_sources enable row level security;
revoke all on supplier_price_ingestion_internal.pending_wahler_quantity_sources from public,anon,authenticated,service_role;

create function public.record_verified_wahler_quantity_source(
  input_organization_id uuid,input_release_id uuid,input_original_sha256 text,input_rows jsonb
)
returns integer language plpgsql security definer set search_path='' as $$
declare
  release public.supplier_price_releases%rowtype;
  receipt supplier_price_ingestion_internal.quantity_tier_receipts%rowtype;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'QUANTITY_TIERS_SERVICE_REQUIRED';
  end if;
  if jsonb_typeof(input_rows) is distinct from 'array' or input_original_sha256 is null then
    raise exception 'QUANTITY_TIERS_INVALID_SOURCE';
  end if;
  if jsonb_array_length(input_rows) not between 2 and 20000 then
    raise exception 'QUANTITY_TIERS_INVALID_SOURCE';
  end if;
  select r.* into release
    from public.supplier_price_releases r
    join public.suppliers s on s.id=r.supplier_id and s.organization_id=r.organization_id
    join public.brands b on b.id=r.brand_id and b.organization_id=r.organization_id
    where r.id=input_release_id and r.organization_id=input_organization_id
      and lower(btrim(s.name))='groupauto' and lower(btrim(b.name))='wahler'
      and r.source_file_path ~ '/wahler-quantity-tiers-[^/]+[.][cC][sS][vV]$'
      and r.source_verification_required and r.mode='replace'
      and r.source_file_sha256=input_original_sha256
      and r.source_file_bytes between 1 and 1048576
    for update of r;
  if not found then raise exception 'QUANTITY_TIERS_RELEASE_MISMATCH'; end if;
  select * into receipt from supplier_price_ingestion_internal.quantity_tier_receipts where release_id=release.id;
  if found then
    if receipt.original_sha256=input_original_sha256
       and receipt.tier_sha256=encode(sha256(convert_to(input_rows::text,'UTF8')),'hex') then
      return receipt.source_rows;
    end if;
    raise exception 'QUANTITY_TIERS_ALREADY_STAGED';
  end if;
  insert into supplier_price_ingestion_internal.pending_wahler_quantity_sources(release_id,original_sha256,rows)
    values(release.id,input_original_sha256,input_rows)
    on conflict(release_id) do nothing;
  if not exists (select 1 from supplier_price_ingestion_internal.pending_wahler_quantity_sources p
    where p.release_id=release.id and p.original_sha256=input_original_sha256 and p.rows=input_rows) then
    raise exception 'QUANTITY_TIERS_ALREADY_STAGED';
  end if;
  return jsonb_array_length(input_rows);
end
$$;
revoke all on function public.record_verified_wahler_quantity_source(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_verified_wahler_quantity_source(uuid,uuid,text,jsonb) to service_role;

create function supplier_price_ingestion_internal.seal_wahler_quantity_release()
returns trigger language plpgsql security definer set search_path='' as $$
declare pending supplier_price_ingestion_internal.pending_wahler_quantity_sources%rowtype;
begin
  if exists (select 1 from supplier_price_ingestion_internal.quantity_tier_receipts q where q.release_id=new.id) then
    return new;
  end if;
  select * into pending from supplier_price_ingestion_internal.pending_wahler_quantity_sources where release_id=new.id;
  if not found then raise exception 'QUANTITY_TIERS_SOURCE_REQUIRED'; end if;
  perform public.stage_verified_supplier_quantity_tiers(
    new.organization_id,new.id,new.source_file_sha256,pending.original_sha256,pending.rows);
  delete from supplier_price_ingestion_internal.pending_wahler_quantity_sources where release_id=new.id;
  return new;
end
$$;
revoke all on function supplier_price_ingestion_internal.seal_wahler_quantity_release() from public,anon,authenticated,service_role;
create trigger supplier_release_seal_wahler_quantity
after update of status on public.supplier_price_releases for each row
when (new.status='validated' and new.source_file_path ~ '/wahler-quantity-tiers-[^/]+[.][cC][sS][vV]$')
execute function supplier_price_ingestion_internal.seal_wahler_quantity_release();
