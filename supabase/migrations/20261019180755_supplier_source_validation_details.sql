-- Store bounded, source-bound diagnostics separately from price rows and decisions.
create table supplier_price_ingestion_internal.source_validation_reports(
 release_id uuid primary key references public.supplier_price_releases(id),
 organization_id uuid not null,source_sha256 text not null check(source_sha256~'^[a-f0-9]{64}$'),
 report jsonb not null,created_at timestamptz not null default now()
);
alter table supplier_price_ingestion_internal.source_validation_reports enable row level security;
revoke all on supplier_price_ingestion_internal.source_validation_reports from public,anon,authenticated,service_role;

create function public.record_supplier_price_source_validation_report(input_release_id uuid,input_handoff_id uuid,input_source_sha256 text,input_report jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare r public.supplier_price_releases%rowtype;s jsonb;total bigint;issues bigint;counts bigint;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SOURCE_REPORT_SERVICE_REQUIRED';end if;
 select * into r from public.supplier_price_releases where id=input_release_id for share;
 if not found or r.source_file_sha256 is distinct from input_source_sha256 or not r.source_verification_required
  or not exists(select 1 from supplier_price_ingestion_internal.handoffs h where h.id=input_handoff_id and h.release_id=r.id
   and h.organization_id=r.organization_id and h.source_sha256=input_source_sha256 and h.total_rows=r.total_rows)
 then raise exception 'SOURCE_REPORT_BINDING_INVALID';end if;
 if jsonb_typeof(input_report) is distinct from 'object' or octet_length(input_report::text)>500000 or coalesce(input_report->>'version','')<>'1'
  or coalesce(input_report->>'validatorVersion','') not in ('legacy','legacy-weight','measurement-v1')
  or jsonb_typeof(input_report->'samples') is distinct from 'array' or jsonb_array_length(input_report->'samples')>500
  or jsonb_typeof(input_report->'counts') is distinct from 'object' or jsonb_typeof(input_report->'truncated') is distinct from 'boolean'
  or coalesce(input_report->>'totalRows','')!~'^[0-9]{1,8}$' or coalesce(input_report->>'issueCount','')!~'^[0-9]{1,9}$'
 then raise exception 'SOURCE_REPORT_INVALID';end if;
 total:=(input_report->>'totalRows')::bigint;issues:=(input_report->>'issueCount')::bigint;
 if total<>r.total_rows or issues<1 or issues>total*20 or jsonb_array_length(input_report->'samples')>issues then raise exception 'SOURCE_REPORT_COUNTS_INVALID';end if;
 if exists(select 1 from jsonb_each_text(input_report->'counts') x where x.value!~'^[0-9]{1,9}$') then raise exception 'SOURCE_REPORT_COUNTS_INVALID';end if;
 select sum(value::bigint) into counts from jsonb_each_text(input_report->'counts');
 if counts is distinct from issues then raise exception 'SOURCE_REPORT_COUNTS_INVALID';end if;
 for s in select value from jsonb_array_elements(input_report->'samples') loop
  if jsonb_typeof(s) is distinct from 'object' or coalesce(s->>'row','')!~'^[0-9]{1,8}$' or (s->>'row')::bigint not between 2 and total+1
   or coalesce(s->>'code','') not in ('MISSING_PRODUCT_CODE','MISSING_BUY_PRICE','INVALID_BUY_PRICE','AMBIGUOUS_BUY_PRICE_FORMAT','INVALID_WEIGHT','INVALID_MOQ','INVALID_LEAD_TIME','INVALID_VALID_FROM','MISSING_DATE','MISSING_CURRENCY','INVALID_CURRENCY','UNSUPPORTED_CURRENCY','DUPLICATE_PRODUCT_CODE')
   or coalesce(s->>'column','') not in ('Product_Code','Buy_Price_Eur','Weight_kg','MOQ','Lead_Time_Days','Price_Date','Currency')
   or coalesce(s->>'severity','') not in ('error','warning') or jsonb_typeof(s->'productCode') is distinct from 'string' or length(s->>'productCode')>120
   or jsonb_typeof(s->'value') is distinct from 'string' or length(s->>'value')>200
  then raise exception 'SOURCE_REPORT_SAMPLE_INVALID';end if;
 end loop;
 insert into supplier_price_ingestion_internal.source_validation_reports(release_id,organization_id,source_sha256,report)
 values(r.id,r.organization_id,input_source_sha256,input_report) on conflict(release_id)do nothing;
 if not exists(select 1 from supplier_price_ingestion_internal.source_validation_reports where release_id=r.id and source_sha256=input_source_sha256 and report=input_report) then raise exception 'SOURCE_REPORT_CONFLICT';end if;
 return jsonb_build_object('status','recorded','releaseId',r.id);
end$$;
revoke all on function public.record_supplier_price_source_validation_report(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_supplier_price_source_validation_report(uuid,uuid,text,jsonb) to service_role;

create function public.get_supplier_price_source_validation_report(input_release_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org uuid:=public.current_profile_org_id();result jsonb;
begin
 if auth.uid() is null or org is null or not exists(select 1 from public.profiles where id=auth.uid() and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'SOURCE_REPORT_ADMIN_REQUIRED';end if;
 if not exists(select 1 from public.supplier_price_releases where id=input_release_id and organization_id=org) then raise exception 'SOURCE_REPORT_NOT_FOUND';end if;
 select report||jsonb_build_object('releaseId',release_id,'createdAt',created_at) into result from supplier_price_ingestion_internal.source_validation_reports where release_id=input_release_id and organization_id=org;
 return result;
end$$;
revoke all on function public.get_supplier_price_source_validation_report(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_supplier_price_source_validation_report(uuid) to authenticated;
