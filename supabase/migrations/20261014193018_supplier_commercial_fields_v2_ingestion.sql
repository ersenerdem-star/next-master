-- Complete verified commercial-field support is an explicit v2 source contract.
-- V1 RPC bodies, source receipts, workflow checkpoints, row hashes and decisions
-- are retained. No historical publication or commercial document is rewritten.
alter table public.supplier_price_release_rows
 add column stock_qty integer,
 add column order_multiple integer,
 add column valid_to date,
 add column commercial_policy text;
alter table public.supplier_price_release_rows
 add constraint supplier_release_rows_commercial_v2_shape check(
  (commercial_policy is null and stock_qty is null and order_multiple is null and valid_to is null)
  or (commercial_policy is not null and commercial_policy='supplier-price-commercial-fields-v2'
    and (stock_qty is null or stock_qty>=0)
    and (order_multiple is null or order_multiple>0)
    and (valid_to is null or (isfinite(valid_to) and valid_to between date '0001-01-01' and date '9999-12-31')))
 );
alter table supplier_price_ingestion_internal.source_compatibility_receipts
 drop constraint source_compatibility_receipts_policy_check;
alter table supplier_price_ingestion_internal.source_compatibility_receipts
 add constraint source_compatibility_receipts_policy_check
 check(policy in('supplier-price-commercial-fields-v1','supplier-price-commercial-fields-v2'));

-- A v2 receipt cannot be used by the old INSERT list (which writes a NULL marker).
-- Conversely, a v1/no-receipt row cannot claim a v2 policy. The old batch RPC and
-- its exact-replay representation remain otherwise unchanged.
create function supplier_price_ingestion_internal.guard_commercial_release_row()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_policy text;v_source_date date;
begin
 select c.policy into v_policy from supplier_price_ingestion_internal.source_compatibility_receipts c where c.release_id=new.release_id;
 if v_policy='supplier-price-commercial-fields-v2' then
  if new.commercial_policy is distinct from v_policy then raise exception 'SUPPLIER_COMMERCIAL_V2_STAGE_REQUIRED';end if;
  select r.source_date into v_source_date from public.supplier_price_releases r where r.id=new.release_id;
  if new.valid_to is not null and (coalesce(new.valid_from,v_source_date) is null or new.valid_to<coalesce(new.valid_from,v_source_date))
  then raise exception 'SUPPLIER_COMMERCIAL_VALID_TO_RANGE';end if;
 elsif new.commercial_policy is not null or new.stock_qty is not null or new.order_multiple is not null or new.valid_to is not null then
  raise exception 'SOURCE_COMPATIBILITY_V2_REQUIRED';
 end if;
 return new;
end $$;
revoke all on function supplier_price_ingestion_internal.guard_commercial_release_row() from public,anon,authenticated,service_role;
create trigger supplier_release_rows_commercial_policy_guard
 before insert or update of release_id,stock_qty,order_multiple,valid_to,valid_from,commercial_policy
 on public.supplier_price_release_rows for each row
 execute function supplier_price_ingestion_internal.guard_commercial_release_row();

create function public.record_supplier_price_source_compatibility_v2(input_release_id uuid,input_handoff_id uuid,input_source_sha256 text,input_total_rows bigint,input_policy text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare c supplier_price_ingestion_internal.source_compatibility_receipts%rowtype;
 r public.supplier_price_releases%rowtype;h supplier_price_ingestion_internal.handoffs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SOURCE_COMPATIBILITY_SERVICE_REQUIRED';end if;
 if input_release_id is null or input_handoff_id is null or input_source_sha256 is null or input_source_sha256!~'^[0-9a-f]{64}$'
 or input_total_rows is null or input_total_rows<=0 or input_policy is distinct from 'supplier-price-commercial-fields-v2' then raise exception 'SOURCE_COMPATIBILITY_INPUT_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-source-compatibility:'||input_release_id::text,0));
 select * into c from supplier_price_ingestion_internal.source_compatibility_receipts where release_id=input_release_id;
 if found then
  if c.handoff_id is distinct from input_handoff_id or c.source_sha256 is distinct from input_source_sha256 or c.total_rows is distinct from input_total_rows or c.policy is distinct from input_policy then raise exception 'SOURCE_COMPATIBILITY_CONFLICT';end if;
  return jsonb_build_object('status','replayed','release_id',c.release_id,'source_sha256',c.source_sha256,'total_rows',c.total_rows,'policy',c.policy);
 end if;
 -- This verifies the sealed Storage object identity/version/size as well as the
 -- original upload manifest. It is intentionally unnecessary on immutable replay.
 select * into r from public.supplier_price_releases where id=input_release_id for update;
 -- First v2 attestation cannot relabel any already claimed/staged v1 work.
 if r.id is null or coalesce(r.current_cursor,0)<>0 or coalesce(r.processed_rows,0)<>0
 or exists(select 1 from public.supplier_price_release_rows rr where rr.release_id=input_release_id)
 or exists(select 1 from public.supplier_price_release_batches b where b.release_id=input_release_id)
 then raise exception 'SOURCE_COMPATIBILITY_V2_ALREADY_STARTED';end if;
 perform public.get_supplier_price_verified_manifest(input_release_id,input_handoff_id);
 select * into h from supplier_price_ingestion_internal.handoffs where id=input_handoff_id and release_id=input_release_id;
 if r.id is null or h.id is null or r.source_file_sha256 is distinct from input_source_sha256 or h.source_sha256 is distinct from input_source_sha256
 or r.total_rows is distinct from input_total_rows or h.total_rows is distinct from input_total_rows
 or h.workflow_id is distinct from 'supplier-price-verified:v1:'||r.id::text
 or not exists(select 1 from public.supplier_price_upload_sessions u where u.id=h.session_id and u.release_id=r.id
  and u.organization_id=r.organization_id and u.status='uploaded' and u.storage_bucket=h.storage_bucket
  and u.storage_object_path=r.source_file_path and u.checksum_sha256=input_source_sha256
  and u.total_bytes=h.source_bytes and u.uploaded_bytes=u.total_bytes)
 then raise exception 'SOURCE_COMPATIBILITY_BINDING';end if;
 insert into supplier_price_ingestion_internal.source_compatibility_receipts(release_id,handoff_id,organization_id,supplier_id,brand_id,source_path,source_sha256,source_bytes,total_rows,policy)
 values(r.id,h.id,r.organization_id,r.supplier_id,r.brand_id,r.source_file_path,input_source_sha256,h.source_bytes,input_total_rows,input_policy);
 return jsonb_build_object('status','recorded','release_id',r.id,'source_sha256',input_source_sha256,'total_rows',input_total_rows,'policy',input_policy);
end $$;
revoke all on function public.record_supplier_price_source_compatibility_v2(uuid,uuid,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.record_supplier_price_source_compatibility_v2(uuid,uuid,text,bigint,text) to service_role;

CREATE OR REPLACE FUNCTION public.stage_supplier_price_release_batch_v2(input_batch_id uuid, input_worker_id text, input_rows jsonb)
 RETURNS TABLE(status text, batch_id uuid, release_id_result uuid, staged_rows bigint, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch public.supplier_price_release_batches%rowtype;
  v_release_id uuid; v_count bigint; v_unique bigint; v_min bigint; v_max bigint;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Supplier shadow staging requires service role';
  end if;
  if input_batch_id is null or nullif(trim(input_worker_id),'') is null
     or input_rows is null or jsonb_typeof(input_rows)<>'array' then
    raise exception 'Invalid supplier shadow staging input';
  end if;
  select b.release_id into v_release_id from public.supplier_price_release_batches b
    where b.id=input_batch_id;
  if not found then raise exception 'Supplier release batch not found'; end if;
  perform 1 from public.supplier_price_releases r where r.id=v_release_id for update;
  select b.* into v_batch from public.supplier_price_release_batches b
    where b.id=input_batch_id for update;
  if v_batch.status<>'running' or v_batch.lease_owner is distinct from trim(input_worker_id)
     or v_batch.lease_expires_at is null or v_batch.lease_expires_at<=clock_timestamp() then
    return query select 'stale'::text,v_batch.id,v_batch.release_id,0::bigint,
      'Lease expired or belongs to another worker.'::text;
    return;
  end if;
  if not exists(select 1 from supplier_price_ingestion_internal.source_compatibility_receipts c
    where c.release_id=v_batch.release_id and c.policy='supplier-price-commercial-fields-v2') then
    raise exception 'SOURCE_COMPATIBILITY_V2_REQUIRED';
  end if;
  if exists(select 1 from jsonb_array_elements(input_rows) j where
    jsonb_typeof(j)<>'object' or not(j ?& array['stock_qty','order_multiple','valid_to'])
    or (j->'stock_qty'<>'null'::jsonb and (jsonb_typeof(j->'stock_qty')<>'number'
      or (j->>'stock_qty')!~'^(0|[1-9][0-9]*)$' or length(j->>'stock_qty')>10))
    or (j->'order_multiple'<>'null'::jsonb and (jsonb_typeof(j->'order_multiple')<>'number'
      or (j->>'order_multiple')!~'^[1-9][0-9]*$' or length(j->>'order_multiple')>10))
    or (j->'valid_to'<>'null'::jsonb and (jsonb_typeof(j->'valid_to')<>'string'
      or (j->>'valid_to')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
  ) then raise exception 'SUPPLIER_COMMERCIAL_V2_ROW_SHAPE';end if;
  -- This marker is SQL-owned, not a caller-provided attestation. It is excluded
  -- from the worker row hash; the three actual source fields are included.
  select jsonb_agg(j||jsonb_build_object('commercial_policy','supplier-price-commercial-fields-v2') order by n)
    into input_rows from jsonb_array_elements(input_rows) with ordinality a(j,n);
  select count(*),count(distinct x.source_row_number),min(x.source_row_number),max(x.source_row_number)
    into v_count,v_unique,v_min,v_max
    from jsonb_to_recordset(input_rows) x(source_row_number bigint);
  if v_count<>v_batch.row_count or v_unique<>v_count
     or v_min<>v_batch.cursor_start or v_max<>v_batch.cursor_end then
    raise exception 'Shadow rows must exactly cover the claimed batch';
  end if;
  if exists(select 1 from jsonb_array_elements(input_rows) j
      where coalesce(length(j->>'row_hash'),0)<>64) then
    raise exception 'Shadow row hash missing or malformed';
  end if;
  if exists(
    select 1 from jsonb_array_elements(input_rows) j
    join public.supplier_price_release_rows rr
      on rr.release_id=v_batch.release_id and rr.source_row_number=(j->>'source_row_number')::bigint
    where (to_jsonb(rr)-'id'-'release_id'-'created_at') is distinct from
      (to_jsonb(jsonb_populate_record(null::public.supplier_price_release_rows,j))-'id'-'release_id'-'created_at')
  ) then raise exception 'Shadow retry payload differs from persisted rows'; end if;
  insert into public.supplier_price_release_rows
    (release_id,source_row_number,normalized_code,product_code,description,oem_no,ean,
     vehicle,vehicle_model,market_segment,dimensions,weight,description_tr,origin,tariff,
     image_url,buy_price,currency,moq,lead_time_days,notes,valid_from,stock_qty,order_multiple,valid_to,commercial_policy,row_hash,
     row_status,error_code,error_message)
  select v_batch.release_id,x.source_row_number,x.normalized_code,x.product_code,
    x.description,x.oem_no,x.ean,x.vehicle,x.vehicle_model,x.market_segment,x.dimensions,
    x.weight,x.description_tr,x.origin,x.tariff,x.image_url,x.buy_price,x.currency,
    x.moq,x.lead_time_days,x.notes,x.valid_from,x.stock_qty,x.order_multiple,x.valid_to,x.commercial_policy,x.row_hash,x.row_status,x.error_code,x.error_message
  from jsonb_populate_recordset(null::public.supplier_price_release_rows,input_rows) x
  on conflict (release_id,source_row_number) do nothing;
  select count(*) into v_count from public.supplier_price_release_rows rr
    where rr.release_id=v_batch.release_id
      and rr.source_row_number between v_batch.cursor_start and v_batch.cursor_end;
  if v_count<>v_batch.row_count then raise exception 'Shadow staged row count mismatch'; end if;
  return query select 'staged'::text,v_batch.id,v_batch.release_id,v_count,
    'Shadow rows persisted; exact replay is immutable; publication disabled.'::text;
end;
$function$;
revoke all on function public.stage_supplier_price_release_batch_v2(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.stage_supplier_price_release_batch_v2(uuid,text,jsonb) to service_role;

create or replace function supplier_price_ingestion_internal.source_publication_blocker(input_release_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare r public.supplier_price_releases%rowtype;v_policy text;
begin
 select * into r from public.supplier_price_releases where id=input_release_id;
 if not found or not r.source_verification_required or not exists(
  select 1 from supplier_price_ingestion_internal.source_compatibility_receipts c
  join supplier_price_ingestion_internal.handoffs h on h.id=c.handoff_id and h.release_id=c.release_id
  where c.release_id=r.id and c.organization_id=r.organization_id and c.supplier_id=r.supplier_id and c.brand_id=r.brand_id
   and c.source_path=r.source_file_path and c.source_sha256=r.source_file_sha256 and c.total_rows=r.total_rows
   and c.source_sha256=h.source_sha256 and c.source_path=h.source_path and c.source_bytes=h.source_bytes
   and c.total_rows=h.total_rows and c.organization_id=h.organization_id
   and h.workflow_id='supplier-price-verified:v1:'||r.id::text and c.policy in ('supplier-price-commercial-fields-v1','supplier-price-commercial-fields-v2')
 )then return 'SOURCE_COMPATIBILITY_REQUIRED';end if;
 select c.policy into v_policy from supplier_price_ingestion_internal.source_compatibility_receipts c where c.release_id=r.id;
 -- Any pointer owns this exact supplier/brand scope. At first transition every
 -- active legacy row matters, including zero-valued stock and future/expired rows.
 if v_policy='supplier-price-commercial-fields-v1' and not exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=r.organization_id and p.supplier_id=r.supplier_id and p.brand_id=r.brand_id)
 and exists(select 1 from public.supplier_prices sp where sp.organization_id=r.organization_id and sp.supplier_id=r.supplier_id and sp.brand_id=r.brand_id and sp.is_active
  and(sp.stock_qty is not null or sp.order_multiple is not null or sp.valid_to is not null))
 then return 'LEGACY_COMMERCIAL_FIELDS_UNSUPPORTED';end if;
 return null;
end $$;
revoke all on function supplier_price_ingestion_internal.source_publication_blocker(uuid) from public,anon,authenticated,service_role;

-- Preserve the existing session/actor/org authorization and response shape.
-- Only fixed failed-verification codes may supplement a missing release error;
-- arbitrary verifier diagnostics and source cell values are never returned.
CREATE OR REPLACE FUNCTION public.get_supplier_price_upload_status(input_session_id uuid, input_actor_id uuid, input_organization_id uuid, input_auth_session_id uuid, input_token_iat bigint, input_token_exp bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u public.supplier_price_upload_sessions%rowtype; r public.supplier_price_releases%rowtype;
 v supplier_price_ingestion_internal.verification_requests%rowtype; p public.profiles%rowtype;
 s auth.sessions%rowtype; ready boolean;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 if input_actor_id is null or input_organization_id is null or input_auth_session_id is null
  or input_token_iat is null or input_token_exp is null or input_token_iat<=0
  or input_token_iat>extract(epoch from clock_timestamp())+30
  or input_token_exp<=extract(epoch from clock_timestamp()) or input_token_exp<=input_token_iat
  then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into s from auth.sessions a where a.id=input_auth_session_id;
 if not found or s.user_id is distinct from input_actor_id
  or (s.not_after is not null and s.not_after<=clock_timestamp()) then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into p from public.profiles a where a.id=input_actor_id;
 if not found or p.is_active is distinct from true or coalesce(p.role,'') not in ('admin','superadmin')
  or p.organization_id is distinct from input_organization_id
  or (p.session_revoked_at is not null and input_token_iat<=extract(epoch from p.session_revoked_at))
  then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into u from public.supplier_price_upload_sessions a where a.id=input_session_id
  and a.created_by=input_actor_id and a.organization_id=input_organization_id;
 if not found then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into r from public.supplier_price_releases a where a.id=u.release_id
  and a.organization_id=u.organization_id and a.created_by=u.created_by;
 if not found or not r.source_verification_required then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into v from supplier_price_ingestion_internal.verification_requests a where a.session_id=u.id;
 -- Presence/size only permits verification submission; it is NOT hash proof.
 select exists(select 1 from storage.objects o where o.bucket_id=u.storage_bucket and o.name=u.storage_object_path
  and nullif(o.version,'') is not null and o.updated_at is not null
  and o.metadata->>'size'=u.total_bytes::text) into ready;
 return jsonb_build_object('session_id',u.id,'release_id',r.id,'upload_status',u.status,
  'verification_status',coalesce(v.status,'not_requested'),'transfer_ready',ready,
  'total_bytes',u.total_bytes,'total_rows',r.total_rows,'processed_rows',r.processed_rows,
  'release_status',r.status,'expires_at',u.expires_at,'updated_at',coalesce(v.updated_at,u.updated_at),
  'error_code',coalesce(r.error_code,case when v.status='failed' and v.last_error in (
   'SOURCE_UNSUPPORTED_STOCK_QTY','SOURCE_UNSUPPORTED_ORDER_MULTIPLE','SOURCE_UNSUPPORTED_VALID_TO','SOURCE_INVALID_STOCK_QTY','SOURCE_INVALID_ORDER_MULTIPLE','SOURCE_INVALID_VALID_TO'
  ) then v.last_error else null end),'release_updated_at',r.updated_at,
  'published',false);
end $function$;
REVOKE ALL ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) TO service_role;
