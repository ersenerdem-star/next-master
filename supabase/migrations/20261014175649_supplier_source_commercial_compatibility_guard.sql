-- Pin proof from a complete original-source parse. Cached normalized parts alone
-- cannot attest that unsupported commercial fields were absent in the source.
create table supplier_price_ingestion_internal.source_compatibility_receipts (
 release_id uuid primary key references public.supplier_price_releases(id),
 handoff_id uuid not null references supplier_price_ingestion_internal.handoffs(id),
 organization_id uuid not null,supplier_id uuid not null,brand_id uuid not null,
 source_path text not null,source_sha256 text not null check(source_sha256~'^[0-9a-f]{64}$'),
 source_bytes bigint not null check(source_bytes>0),total_rows bigint not null check(total_rows>0),
 policy text not null check(policy='supplier-price-commercial-fields-v1'),
 created_at timestamptz not null default now()
);
alter table supplier_price_ingestion_internal.source_compatibility_receipts enable row level security;
revoke all on table supplier_price_ingestion_internal.source_compatibility_receipts from public,anon,authenticated,service_role;
create function supplier_price_ingestion_internal.reject_source_compatibility_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin raise exception 'SOURCE_COMPATIBILITY_IMMUTABLE';end $$;
revoke all on function supplier_price_ingestion_internal.reject_source_compatibility_change() from public,anon,authenticated,service_role;
create trigger source_compatibility_receipts_immutable before update or delete on supplier_price_ingestion_internal.source_compatibility_receipts
for each row execute function supplier_price_ingestion_internal.reject_source_compatibility_change();

create function public.record_supplier_price_source_compatibility(input_release_id uuid,input_handoff_id uuid,input_source_sha256 text,input_total_rows bigint,input_policy text)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare c supplier_price_ingestion_internal.source_compatibility_receipts%rowtype;
 r public.supplier_price_releases%rowtype;h supplier_price_ingestion_internal.handoffs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SOURCE_COMPATIBILITY_SERVICE_REQUIRED';end if;
 if input_release_id is null or input_handoff_id is null or input_source_sha256 is null or input_source_sha256!~'^[0-9a-f]{64}$'
 or input_total_rows is null or input_total_rows<=0 or input_policy is distinct from 'supplier-price-commercial-fields-v1' then raise exception 'SOURCE_COMPATIBILITY_INPUT_INVALID';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-source-compatibility:'||input_release_id::text,0));
 select * into c from supplier_price_ingestion_internal.source_compatibility_receipts where release_id=input_release_id;
 if found then
  if c.handoff_id is distinct from input_handoff_id or c.source_sha256 is distinct from input_source_sha256 or c.total_rows is distinct from input_total_rows or c.policy is distinct from input_policy then raise exception 'SOURCE_COMPATIBILITY_CONFLICT';end if;
  return jsonb_build_object('status','replayed','release_id',c.release_id,'source_sha256',c.source_sha256,'total_rows',c.total_rows,'policy',c.policy);
 end if;
 -- This verifies the sealed Storage object identity/version/size as well as the
 -- original upload manifest. It is intentionally unnecessary on immutable replay.
 select * into r from public.supplier_price_releases where id=input_release_id for share;
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
revoke all on function public.record_supplier_price_source_compatibility(uuid,uuid,text,bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.record_supplier_price_source_compatibility(uuid,uuid,text,bigint,text) to service_role;

create function supplier_price_ingestion_internal.source_publication_blocker(input_release_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare r public.supplier_price_releases%rowtype;
begin
 select * into r from public.supplier_price_releases where id=input_release_id;
 if not found or not r.source_verification_required or not exists(
  select 1 from supplier_price_ingestion_internal.source_compatibility_receipts c
  join supplier_price_ingestion_internal.handoffs h on h.id=c.handoff_id and h.release_id=c.release_id
  where c.release_id=r.id and c.organization_id=r.organization_id and c.supplier_id=r.supplier_id and c.brand_id=r.brand_id
   and c.source_path=r.source_file_path and c.source_sha256=r.source_file_sha256 and c.total_rows=r.total_rows
   and c.source_sha256=h.source_sha256 and c.source_path=h.source_path and c.source_bytes=h.source_bytes
   and c.total_rows=h.total_rows and c.organization_id=h.organization_id
   and h.workflow_id='supplier-price-verified:v1:'||r.id::text and c.policy='supplier-price-commercial-fields-v1'
 )then return 'SOURCE_COMPATIBILITY_REQUIRED';end if;
 -- Any pointer owns this exact supplier/brand scope. At first transition every
 -- active legacy row matters, including zero-valued stock and future/expired rows.
 if not exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=r.organization_id and p.supplier_id=r.supplier_id and p.brand_id=r.brand_id)
 and exists(select 1 from public.supplier_prices sp where sp.organization_id=r.organization_id and sp.supplier_id=r.supplier_id and sp.brand_id=r.brand_id and sp.is_active
  and(sp.stock_qty is not null or sp.order_multiple is not null or sp.valid_to is not null))
 then return 'LEGACY_COMMERCIAL_FIELDS_UNSUPPORTED';end if;
 return null;
end $$;
revoke all on function supplier_price_ingestion_internal.source_publication_blocker(uuid) from public,anon,authenticated,service_role;

create function supplier_price_ingestion_internal.guard_source_publication()
returns trigger language plpgsql security definer set search_path='' as $$
declare r public.supplier_price_releases%rowtype;blocker text;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-publication:'||new.organization_id::text,0));
 select * into r from public.supplier_price_releases where id=new.release_id;
 if not found or r.organization_id is distinct from new.organization_id or r.supplier_id is distinct from new.supplier_id or r.brand_id is distinct from new.brand_id
 or r.status is distinct from 'validated' then raise exception 'PRODUCTION_PUBLICATION_SOURCE_INVALID';end if;
 blocker:=supplier_price_ingestion_internal.source_publication_blocker(new.release_id);
 if blocker is not null then raise exception 'PRODUCTION_PUBLICATION_%',blocker;end if;
 return new;
end $$;
revoke all on function supplier_price_ingestion_internal.guard_source_publication() from public,anon,authenticated,service_role;
create trigger supplier_publications_require_source_compatibility before insert on public.supplier_price_publications
for each row when(new.status='published')execute function supplier_price_ingestion_internal.guard_source_publication();

-- Share the publisher's transaction lock before checking pointers. A writer
-- waiting behind the first publication sees its committed pointer; a publisher
-- waiting behind a legacy writer sees the committed unsupported fields.
create or replace function public.reject_legacy_supplier_price_published_write()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_org uuid;
begin
 if tg_op='DELETE' and old.is_active is not true then return old;end if;
 for v_org in select distinct x from unnest(case when tg_op='INSERT' then array[new.organization_id]
  when tg_op='DELETE' then array[old.organization_id]else array[old.organization_id,new.organization_id]end)x where x is not null order by x
 loop perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-publication:'||v_org::text,0));end loop;
 if tg_op='DELETE' then
  if exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=old.organization_id and p.brand_id=old.brand_id)then raise exception 'LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED';end if;
  return old;
 end if;
 if exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=new.organization_id and p.brand_id=new.brand_id)
 or(tg_op='UPDATE'and(old.organization_id is distinct from new.organization_id or old.brand_id is distinct from new.brand_id)
  and exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=old.organization_id and p.brand_id=old.brand_id))
 then raise exception 'LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED';end if;
 return new;
end $$;
revoke all on function public.reject_legacy_supplier_price_published_write() from public,anon,authenticated;
drop trigger supplier_prices_reject_published_legacy_write on public.supplier_prices;
create trigger supplier_prices_reject_published_legacy_write before insert or update of organization_id,supplier_id,brand_id,
 product_code,normalized_code,buy_price,currency,valid_from,valid_to,is_active,moq,order_multiple,stock_qty,lead_time_days or delete
on public.supplier_prices for each row execute function public.reject_legacy_supplier_price_published_write();

-- Existing actor/session, publication switch and decision receipts are retained.
create or replace function public.get_supplier_release_action_evidence(input_project_ref text,input_actor_id uuid,input_organization_id uuid,input_auth_session_id uuid,input_token_iat bigint,input_token_exp bigint,input_release_id uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare r public.supplier_price_releases%rowtype;p public.supplier_current_price_pointers%rowtype;v boolean;busy boolean;publication_enabled boolean:=false;review_op jsonb;publish_op jsonb;blocker text;
begin
 perform supplier_price_ingestion_internal.admin_action_target(input_project_ref);
 perform supplier_price_ingestion_internal.admin_action_session(input_actor_id,input_organization_id,input_auth_session_id,input_token_iat,input_token_exp);
 select * into r from public.supplier_price_releases where id=input_release_id and organization_id=input_organization_id;
 if not found then raise exception 'ACTION_SCOPE_DENIED';end if;
 if octet_length(r.brand_identity_audit::text)>16384 then raise exception 'ACTION_EVIDENCE_TOO_LARGE';end if;
 select * into p from public.supplier_current_price_pointers where organization_id=r.organization_id and supplier_id=r.supplier_id and brand_id=r.brand_id;
 v:=supplier_price_ingestion_internal.admin_action_source_verified(r.id);
 blocker:=case when r.status='published' and p.release_id=r.id then null else supplier_price_ingestion_internal.source_publication_blocker(r.id)end;
 -- Release readiness is insufficient while the independently governed production
 -- publication switch is closed. V3 has no dependency on production-only tables.
 if input_project_ref='kaxsqafdevabkxofwdod' then
  publication_enabled:=true;
 elsif input_project_ref='zjgueqijumzlfioihnkt' and to_regclass('supplier_price_ingestion_internal.production_publication_control') is not null then
  select exists(select 1 from supplier_price_ingestion_internal.production_publication_control c
   where c.singleton and c.enabled and c.expected_project_ref=input_project_ref) into publication_enabled;
 end if;
 select exists(select 1 from supplier_price_ingestion_internal.admin_release_actions a where a.release_id=r.id and a.status in ('queued','running')) into busy;
 select jsonb_build_object('decisionId',a.decision_id,'status',a.status,'receipt',case when a.receipt is not null then supplier_price_ingestion_internal.admin_action_receipt(a,true) else null end,'errorCode',a.error_code) into review_op from supplier_price_ingestion_internal.admin_release_actions a where a.release_id=r.id and a.actor_id=input_actor_id and a.action='review' order by a.created_at desc,a.decision_id desc limit 1;
 select jsonb_build_object('decisionId',a.decision_id,'status',a.status,'receipt',case when a.receipt is not null then supplier_price_ingestion_internal.admin_action_receipt(a,true) else null end,'errorCode',a.error_code) into publish_op from supplier_price_ingestion_internal.admin_release_actions a where a.release_id=r.id and a.actor_id=input_actor_id and a.action='publish' order by a.created_at desc,a.decision_id desc limit 1;
 return jsonb_build_object('actorId',input_actor_id,'organizationId',r.organization_id,'releaseId',r.id,'supplierId',r.supplier_id,'brandId',r.brand_id,
 'supplier',(select name from public.suppliers where id=r.supplier_id and organization_id=r.organization_id),'brand',(select name from public.brands where id=r.brand_id and organization_id=r.organization_id),
 'mode',r.mode,'status',r.status,'reviewRevision',r.review_revision,'errorCode',r.error_code,'brandIdentityAudit',r.brand_identity_audit,
 'totalRows',coalesce(r.total_rows,0),'processedRows',coalesce(r.processed_rows,0),'acceptedRows',coalesce(r.accepted_rows,0),'rejectedRows',coalesce(r.rejected_rows,0),'warningRows',coalesce(r.warning_rows,0),'conflictRows',coalesce(r.conflict_rows,0),
 'sourceVerified',v,'currentPublicationId',p.publication_id,'currentReleaseId',p.release_id,'currentPublicationVersion',(select publication_version from public.supplier_price_publications where id=p.publication_id),'isCurrent',coalesce(p.release_id=r.id,false),
 'canReview',coalesce(v and not busy and r.status in ('staged','validated') and (r.error_code is not null or coalesce(r.brand_identity_audit->>'review_required','false')='true'),false),
 'publicationBlocker',blocker,'canPublish',coalesce(blocker is null and publication_enabled and v and not busy and r.status='validated' and r.mode='replace' and r.error_code is null and r.total_rows>0 and r.accepted_rows=r.total_rows and r.current_cursor=r.total_rows and r.processed_rows=r.total_rows and r.rejected_rows=0 and r.warning_rows=0 and r.conflict_rows=0 and coalesce(r.brand_identity_audit->>'checked','false')='true' and coalesce(r.brand_identity_audit->>'review_required','true')='false',false),
 'reviewOperation',review_op,'publishOperation',publish_op);
end $$;
