-- A review is specific to one verified upload, current pointer, exact row
-- contents and exact cross-brand evidence. It never approves other failures.
create table supplier_price_validation_internal.overlap_approvals (
 decision_id uuid primary key,
 organization_id uuid not null,
 supplier_id uuid not null,
 brand_id uuid not null,
 release_id uuid not null references public.supplier_price_releases(id),
 actor_id uuid not null,
 review_revision bigint not null,
 source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
 rows_sha256 text not null check (rows_sha256 ~ '^[a-f0-9]{64}$'),
 match_sha256 text not null check (match_sha256 ~ '^[a-f0-9]{64}$'),
 audit jsonb not null,
 expected_previous_publication_id uuid,
 approved_at timestamptz not null default now()
);
alter table supplier_price_validation_internal.overlap_approvals enable row level security;
revoke all on supplier_price_validation_internal.overlap_approvals from public,anon,authenticated,service_role;
create function supplier_price_validation_internal.overlap_approval_immutable() returns trigger
language plpgsql set search_path='' as $$ begin raise exception 'REVIEW_IMMUTABLE'; end $$;
create trigger overlap_approval_immutable before update or delete on supplier_price_validation_internal.overlap_approvals
for each row execute function supplier_price_validation_internal.overlap_approval_immutable();

-- Cryptographic digest covers every stored field in every row, in source order;
-- changing a price, a code, a rejected row, or any other imported field stales the review.
create function supplier_price_validation_internal.overlap_rows_sha256(input_release_id uuid) returns text
language sql stable set search_path='' as $$
 select encode(pg_catalog.sha256(coalesce(string_agg(pg_catalog.sha256(convert_to(to_jsonb(rr)::text,'UTF8')),
  ''::bytea order by rr.source_row_number,rr.id),''::bytea)),'hex')
 from public.supplier_price_release_rows rr where rr.release_id=input_release_id
$$;

create function supplier_price_validation_internal.overlap_approval_valid(input_release_id uuid,input_audit jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.supplier_price_releases r
  join supplier_price_validation_internal.overlap_approvals a on a.release_id=r.id
  where r.id=input_release_id and a.organization_id=r.organization_id and a.supplier_id=r.supplier_id
   and a.brand_id=r.brand_id and a.review_revision=r.review_revision and a.source_sha256=r.source_file_sha256
   and a.audit=jsonb_set(input_audit - 'checked_at' - 'superadmin_overlap_approved' - 'original_review_required' - 'full_match_fingerprint','{review_required}','true'::jsonb)
   and a.match_sha256=input_audit->>'full_match_fingerprint'
   and a.rows_sha256=supplier_price_validation_internal.overlap_rows_sha256(r.id)
   and a.expected_previous_publication_id is not distinct from
    (select p.publication_id from public.supplier_current_price_pointers p where p.organization_id=r.organization_id and p.supplier_id=r.supplier_id and p.brand_id=r.brand_id)
   and exists(select 1 from public.profiles p where p.id=a.actor_id and p.organization_id=r.organization_id and p.is_active=true and lower(p.role::text)='superadmin')
   and supplier_price_ingestion_internal.admin_action_source_verified(r.id))
$$;

create function supplier_price_validation_internal.approve_overlap(a supplier_price_ingestion_internal.admin_release_actions)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.supplier_price_releases%rowtype; fresh jsonb; validation jsonb; pointer_id uuid; new_revision bigint;
begin
 select * into r from public.supplier_price_releases where id=a.release_id and organization_id=a.organization_id for update;
 if not found or r.supplier_id is distinct from a.supplier_id or r.brand_id is distinct from a.brand_id then raise exception 'REVIEW_SCOPE_DENIED';end if;
 if not exists(select 1 from public.profiles p where p.id=a.actor_id and p.organization_id=r.organization_id and p.is_active=true and lower(p.role::text)='superadmin') then raise exception 'REVIEW_ACTOR_DENIED';end if;
 if a.request->>'action'<>'approve_overlap' or a.request->>'reason'<>'cross_brand_overlap_accepted'
  or a.request->>'expectedError'<>'CROSS_BRAND_BULK_OVERLAP' or r.error_code is distinct from 'CROSS_BRAND_BULK_OVERLAP'
  or r.status is distinct from 'validated' or r.mode is distinct from 'replace' or r.validated_at is null
  or r.review_revision is distinct from (a.request->>'expectedRevision')::bigint
  or r.status is distinct from a.request->>'expectedStatus' or r.brand_identity_audit is distinct from a.request->'expectedAudit'
  or r.source_file_sha256 is distinct from a.request->>'expectedSourceSha256' or r.source_file_sha256 is distinct from a.source_sha256
  or supplier_price_validation_internal.overlap_rows_sha256(r.id) is distinct from a.request->>'expectedRowsSha256'
  or not supplier_price_ingestion_internal.admin_action_source_verified(r.id)
  then raise exception 'REVIEW_STALE_EVIDENCE';end if;
 if r.total_rows<=0 or r.accepted_rows<>r.total_rows or r.processed_rows<>r.total_rows or r.current_cursor<>r.total_rows
  or coalesce(r.rejected_rows,-1)<>0 or coalesce(r.warning_rows,-1)<>0 or coalesce(r.conflict_rows,-1)<>0
  or (select count(*) from public.supplier_price_release_rows rr where rr.release_id=r.id)<>r.total_rows
  or exists(select 1 from public.supplier_price_release_rows rr where rr.release_id=r.id and rr.row_status is distinct from 'accepted')
  then raise exception 'REVIEW_ROWS_NOT_CLEAR';end if;
 select p.publication_id into pointer_id from public.supplier_current_price_pointers p
  where p.organization_id=r.organization_id and p.supplier_id=r.supplier_id and p.brand_id=r.brand_id;
 if pointer_id is distinct from (a.request->>'expectedPreviousPublicationId')::uuid then raise exception 'REVIEW_STALE_POINTER';end if;
 perform set_config('supplier.overlap_compute','on',true);
 fresh:=supplier_price_validation_internal.cross_brand_audit(r.id);
 perform set_config('supplier.overlap_compute','off',true);
 if fresh->>'checked' is distinct from 'true' or fresh->>'review_required' is distinct from 'true'
  or coalesce(fresh->>'full_match_fingerprint','') !~ '^[a-f0-9]{64}$'
  or fresh->>'full_match_fingerprint' is distinct from a.request->>'expectedMatchSha256'
  or (fresh-'checked_at'-'full_match_fingerprint') is distinct from (r.brand_identity_audit-'checked_at'-'full_match_fingerprint') then raise exception 'REVIEW_STALE_EVIDENCE';end if;
 new_revision:=r.review_revision+1;
 insert into supplier_price_validation_internal.overlap_approvals(decision_id,organization_id,supplier_id,brand_id,release_id,actor_id,review_revision,source_sha256,rows_sha256,match_sha256,audit,expected_previous_publication_id)
 values(a.decision_id,r.organization_id,r.supplier_id,r.brand_id,r.id,a.actor_id,new_revision,r.source_file_sha256,
 a.request->>'expectedRowsSha256',fresh->>'full_match_fingerprint',fresh-'checked_at'-'full_match_fingerprint',pointer_id);
 update public.supplier_price_releases set review_revision=new_revision,updated_at=now() where id=r.id;
 validation:=public.validate_supplier_price_release(r.id);
 if validation->>'publishable' is distinct from 'true' or validation->'brand_identity_audit'->>'superadmin_overlap_approved' is distinct from 'true'
  then raise exception 'REVIEW_ROWS_NOT_CLEAR';end if;
 insert into public.supplier_price_release_events(release_id,event_type,stage,status,worker_version)
 values(r.id,'release_review_approve_overlap','review','overlap_approved','overlap-approval-v1');
 return jsonb_build_object('status','overlap_approved','review_revision',new_revision,'error_code',null,'published',false);
end $$;

-- The original audit remains intact and only recognizes a matching immutable
-- decision after recomputing the current source, rows and audit evidence.
do $patch$ declare definition text;marker text:='  return v_result;';replacement text:=$new$
  if v_result->>'checked'='true' and v_result->>'review_required'='true'
   and supplier_price_validation_internal.overlap_approval_valid(v_release.id,v_result) then
    v_result:=v_result||jsonb_build_object('review_required',false,'original_review_required',true,'superadmin_overlap_approved',true);
  end if;
  return v_result;
$new$;begin
 definition:=pg_get_functiondef('supplier_price_validation_internal.cross_brand_audit(uuid)'::regprocedure);
 definition:=replace(definition,$old$'distinct_incoming_codes',(select n from counts),$old$,$new$
    'full_match_fingerprint',case when current_setting('supplier.overlap_compute',true)='on'
      or exists(select 1 from supplier_price_validation_internal.overlap_approvals oa where oa.release_id=v_release.id)
     then (select encode(pg_catalog.sha256(coalesce(string_agg(pg_catalog.sha256(convert_to(x.tag||':'||x.brand_id::text||':'||x.code,'UTF8')),''::bytea order by x.tag collate "C",x.brand_id,x.code collate "C"),''::bytea)),'hex')
       from (select case when historical then 'historical' else 'current' end tag,brand_id,code from ranked
        union all select 'dimension' tag,brand_id,code from dimension_matches) x) else null end,
    'distinct_incoming_codes',(select n from counts),$new$);
 if position('full_match_fingerprint' in definition)=0 then raise exception 'OVERLAP_AUDIT_DEFINITION_DRIFT';end if;
 if position(marker in definition)=0 or position('overlap_approval_valid' in definition)>0 then raise exception 'OVERLAP_AUDIT_DEFINITION_DRIFT';end if;
 -- Insert at the final return, after existing reviewed-file exceptions.
 definition:=regexp_replace(definition,'  return v_result;(?=\s*end;\s*\$function\$)',replacement);
 if position('overlap_approval_valid' in definition)=0 then raise exception 'OVERLAP_AUDIT_DEFINITION_DRIFT';end if;
 execute definition;
end $patch$;

create function supplier_price_validation_internal.overlap_live_valid(input_release_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare fresh jsonb;
begin
 fresh:=supplier_price_validation_internal.cross_brand_audit(input_release_id);
 return coalesce(fresh->>'superadmin_overlap_approved'='true' and fresh->>'review_required'='false',false);
end $$;

create function supplier_price_validation_internal.overlap_candidate_audit(input_release_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare fresh jsonb;
begin
 perform set_config('supplier.overlap_compute','on',true);
 fresh:=supplier_price_validation_internal.cross_brand_audit(input_release_id);
 perform set_config('supplier.overlap_compute','off',true);
 return fresh;
end $$;

-- Queue accepts the stronger approval command. Existing review commands retain
-- their previous shape and permissions.
do $patch$ declare definition text;begin
 definition:=pg_get_functiondef('public.request_supplier_release_action(text,uuid,uuid,uuid,bigint,bigint,text,jsonb)'::regprocedure);
 if position($marker$or (input_action='publish' and keys<>array[$marker$ in definition)=0 then raise exception 'OVERLAP_REQUEST_DEFINITION_DRIFT';end if;
 definition:=replace(definition,$old$if (input_action='review' and keys<>array['action','decisionId','expectedAudit','expectedError','expectedRevision','expectedStatus','reason','releaseId'])$old$,
 $new$if (input_action='review' and keys<>case when input_request->>'action'='approve_overlap' then array['action','decisionId','expectedAudit','expectedError','expectedMatchSha256','expectedPreviousPublicationId','expectedRevision','expectedRowsSha256','expectedSourceSha256','expectedStatus','reason','releaseId'] else array['action','decisionId','expectedAudit','expectedError','expectedRevision','expectedStatus','reason','releaseId'] end)$new$);
 definition:=replace(definition,$old$input_request->>'action' not in ('recheck','reject')$old$,$new$input_request->>'action' not in ('recheck','reject','approve_overlap')$new$);
 definition:=replace(definition,$old$or (input_request->>'action'='reject' and input_request->>'reason' not in ('wrong_brand_file','wrong_source_file'))$old$,
 $new$or (input_request->>'action'='reject' and input_request->>'reason' not in ('wrong_brand_file','wrong_source_file'))
   or (input_request->>'action'='approve_overlap' and (input_request->>'reason'<>'cross_brand_overlap_accepted'
    or r.error_code is distinct from 'CROSS_BRAND_BULK_OVERLAP'
    or input_request->>'expectedSourceSha256' is distinct from r.source_file_sha256
    or coalesce(input_request->>'expectedMatchSha256','') !~ '^[a-f0-9]{64}$'
    or coalesce(input_request->>'expectedRowsSha256','') !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(input_request->'expectedPreviousPublicationId') not in ('null','string')
    or (select publication_id from public.supplier_current_price_pointers where organization_id=r.organization_id and supplier_id=r.supplier_id and brand_id=r.brand_id) is distinct from (input_request->>'expectedPreviousPublicationId')::uuid
    or not exists(select 1 from public.profiles p where p.id=input_actor_id and p.organization_id=input_organization_id and p.is_active=true and lower(p.role::text)='superadmin')))$new$);
 definition:=replace(definition,$old$(r.error_code is null and coalesce(r.brand_identity_audit->>'review_required','false')<>'true')$old$,
 $new$(r.error_code is null and coalesce(r.brand_identity_audit->>'review_required','false')<>'true'
   and not (input_request->>'action'='recheck' and coalesce(r.brand_identity_audit->>'superadmin_overlap_approved','false')='true' and not supplier_price_validation_internal.overlap_live_valid(r.id)))$new$);
 if position('expectedSourceSha256' in definition)=0 or position('cross_brand_overlap_accepted' in definition)=0 then raise exception 'OVERLAP_REQUEST_DEFINITION_DRIFT';end if;
 execute definition;
end $patch$;

-- A stale approval is not a waiver. Permit only an ordinary fresh recheck so
-- the operator can review the newly detected hold instead of being stranded.
do $patch$ declare definition text;begin
 definition:=pg_get_functiondef('supplier_price_validation_internal.review_release(uuid,uuid,uuid,uuid,text,text,bigint,text,text,jsonb)'::regprocedure);
 definition:=replace(definition,$old$if v_release.error_code is null and coalesce(v_release.brand_identity_audit->>'review_required','false')<>'true'$old$,
 $new$if v_release.error_code is null and coalesce(v_release.brand_identity_audit->>'review_required','false')<>'true'
   and not (input_action='recheck' and coalesce(v_release.brand_identity_audit->>'superadmin_overlap_approved','false')='true'
     and not supplier_price_validation_internal.overlap_live_valid(v_release.id))$new$);
 if position('overlap_live_valid' in definition)=0 then raise exception 'OVERLAP_REVIEW_DEFINITION_DRIFT';end if;
 execute definition;
end $patch$;

do $patch$ declare definition text;begin
 definition:=pg_get_functiondef('public.execute_supplier_release_action(text,uuid,uuid)'::regprocedure);
 definition:=replace(definition,$old$result:=supplier_price_validation_internal.review_release(a.decision_id,a.actor_id,a.organization_id,a.release_id,a.request->>'action',a.request->>'reason',(a.request->>'expectedRevision')::bigint,a.request->>'expectedStatus',a.request->>'expectedError',nullif(a.request->'expectedAudit','null'::jsonb));$old$,
 $new$if a.request->>'action'='approve_overlap' then
   result:=supplier_price_validation_internal.approve_overlap(a);
  else
   result:=supplier_price_validation_internal.review_release(a.decision_id,a.actor_id,a.organization_id,a.release_id,a.request->>'action',a.request->>'reason',(a.request->>'expectedRevision')::bigint,a.request->>'expectedStatus',a.request->>'expectedError',nullif(a.request->'expectedAudit','null'::jsonb));
  end if;$new$);
 if position('supplier_price_validation_internal.approve_overlap(a)' in definition)=0 then raise exception 'OVERLAP_WORKER_DEFINITION_DRIFT';end if;
 execute definition;
end $patch$;

do $patch$ declare definition text;begin
 definition:=pg_get_functiondef('public.get_supplier_release_action_evidence(text,uuid,uuid,uuid,bigint,bigint,uuid)'::regprocedure);
 definition:=replace(definition,$old$publication_enabled boolean:=false;$old$,$new$publication_enabled boolean:=false; overlap_current boolean:=false; overlap_candidate jsonb; overlap_rows text;$new$);
 definition:=replace(definition,$old$v:=supplier_price_ingestion_internal.admin_action_source_verified(r.id);$old$,
 $new$v:=supplier_price_ingestion_internal.admin_action_source_verified(r.id);
 if r.status='validated' and coalesce(r.brand_identity_audit->>'superadmin_overlap_approved','false')='true' then
  overlap_current:=supplier_price_validation_internal.overlap_live_valid(r.id);
 elsif r.error_code='CROSS_BRAND_BULK_OVERLAP' and exists(select 1 from public.profiles pp where pp.id=input_actor_id and pp.organization_id=r.organization_id and pp.is_active=true and lower(pp.role::text)='superadmin') then
  overlap_candidate:=supplier_price_validation_internal.overlap_candidate_audit(r.id);
  overlap_rows:=supplier_price_validation_internal.overlap_rows_sha256(r.id);
 end if;$new$);
 definition:=replace(definition,$old$(r.error_code is not null or coalesce(r.brand_identity_audit->>'review_required','false')='true')$old$,
 $new$(r.error_code is not null or coalesce(r.brand_identity_audit->>'review_required','false')='true'
   or (coalesce(r.brand_identity_audit->>'superadmin_overlap_approved','false')='true' and not overlap_current))$new$);
 definition:=replace(definition,$old$'canPublish',coalesce(blocker is null and publication_enabled$old$,$new$'canPublish',coalesce((coalesce(r.brand_identity_audit->>'superadmin_overlap_approved','false')<>'true' or overlap_current) and blocker is null and publication_enabled$new$);
 definition:=replace(definition,$old$'reviewOperation',review_op,'publishOperation',publish_op$old$,
 $new$'sourceSha256',case when v then r.source_file_sha256 else null end,
 'canApproveOverlap',coalesce(v and not busy and r.status='validated' and r.mode='replace' and r.error_code='CROSS_BRAND_BULK_OVERLAP'
  and r.brand_identity_audit->>'checked'='true' and r.brand_identity_audit->>'review_required'='true'
  and overlap_candidate->>'checked'='true' and overlap_candidate->>'review_required'='true'
  and coalesce(overlap_candidate->>'full_match_fingerprint','') ~ '^[a-f0-9]{64}$'
  and coalesce(overlap_rows,'') ~ '^[a-f0-9]{64}$'
  and (overlap_candidate-'checked_at'-'full_match_fingerprint')=(r.brand_identity_audit-'checked_at'-'full_match_fingerprint')
  and r.total_rows>0 and r.accepted_rows=r.total_rows and r.processed_rows=r.total_rows and r.current_cursor=r.total_rows
  and r.rejected_rows=0 and r.warning_rows=0 and r.conflict_rows=0
  and exists(select 1 from public.profiles pp where pp.id=input_actor_id and pp.organization_id=r.organization_id and pp.is_active=true and lower(pp.role::text)='superadmin'),false),
 'overlapApproved',coalesce(r.brand_identity_audit->>'superadmin_overlap_approved'='true' and (r.status in ('published','superseded') or overlap_current),false),
 'overlapApprovalStale',coalesce(r.status='validated' and r.brand_identity_audit->>'superadmin_overlap_approved'='true' and not overlap_current,false),
 'overlapMatchFingerprint',overlap_candidate->>'full_match_fingerprint',
 'overlapRowsFingerprint',overlap_rows,
 'reviewOperation',review_op,'publishOperation',publish_op$new$);
 if position('canApproveOverlap' in definition)=0 or position('coalesce(r.brand_identity_audit->>''superadmin_overlap_approved'',''false'')<>''true''' in definition)=0 then raise exception 'OVERLAP_EVIDENCE_DEFINITION_DRIFT';end if;
 execute definition;
end $patch$;
revoke all on function supplier_price_validation_internal.overlap_approval_immutable() from public,anon,authenticated,service_role;
revoke all on function supplier_price_validation_internal.overlap_rows_sha256(uuid) from public,anon,authenticated,service_role;
revoke all on function supplier_price_validation_internal.overlap_approval_valid(uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function supplier_price_validation_internal.overlap_live_valid(uuid) from public,anon,authenticated,service_role;
revoke all on function supplier_price_validation_internal.overlap_candidate_audit(uuid) from public,anon,authenticated,service_role;
revoke all on function supplier_price_validation_internal.approve_overlap(supplier_price_ingestion_internal.admin_release_actions) from public,anon,authenticated,service_role;
