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
   'SOURCE_UNSUPPORTED_STOCK_QTY','SOURCE_UNSUPPORTED_ORDER_MULTIPLE','SOURCE_UNSUPPORTED_VALID_TO'
  ) then v.last_error else null end),'release_updated_at',r.updated_at,
  'published',false);
end $function$;
REVOKE ALL ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) TO service_role;
