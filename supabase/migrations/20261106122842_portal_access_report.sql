-- Report only observed, organization-attributed portal access events.
-- Historical logs are not rewritten or inferred from later sessions.
alter table public.portal_audit_logs add column if not exists country_code text;
alter table public.portal_audit_logs add column if not exists country_source text;
alter table public.portal_audit_logs add constraint portal_audit_country_code_check
 check(country_code is null or country_code ~ '^[A-Z]{2}$');
alter table public.portal_audit_logs add constraint portal_audit_country_source_check
 check(country_source is null or country_source='netlify_geo');
create index if not exists idx_portal_audit_access_org_time
 on public.portal_audit_logs(organization_id,created_at desc,id desc)
 where event_type in('portal_login','portal_logout','portal_session_resume','portal_session_rejected');
create index if not exists idx_portal_audit_access_org_country_time
 on public.portal_audit_logs(organization_id,country_code,created_at desc,id desc)
 where event_type in('portal_login','portal_logout','portal_session_resume','portal_session_rejected');

create or replace function public.admin_portal_access_report(
 input_from timestamptz default null,input_to timestamptz default null,
 input_page integer default 1,input_page_size integer default 50,input_search text default '',
 input_invite_id uuid default null,input_event text default '',input_status text default '',
 input_country text default '',input_as_of timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare
 org uuid:=public.current_profile_org_id();
 anchor timestamptz:=coalesce(input_as_of,statement_timestamp());
 since_time timestamptz;
 until_time timestamptz;
 page_number integer:=coalesce(input_page,1);
 page_size integer:=coalesce(input_page_size,50);
 search_term text:=btrim(coalesce(input_search,''));
 event_filter text:=coalesce(input_event,'');
 status_filter text:=coalesce(input_status,'');
 country_filter text:=coalesce(input_country,'');
 result jsonb;
begin
 if auth.uid() is null or org is null or not coalesce(public.is_superadmin() or
  (public.current_profile_role()='admin' and public.profile_has_permission('reports.view')),false)
 then raise exception 'PORTAL_ACCESS_REPORT_ADMIN_REQUIRED';end if;
 since_time:=coalesce(input_from,anchor-interval '30 days');
 until_time:=coalesce(input_to,anchor);
 if not isfinite(anchor) or not isfinite(since_time) or not isfinite(until_time)
  or anchor>statement_timestamp() or since_time>=until_time
  or until_time-since_time>interval '366 days'
  or page_number not between 1 and 10000 or page_size not between 1 and 250
  or length(search_term)>200
  or event_filter not in('','portal_login','portal_logout','portal_session_resume','portal_session_rejected')
  or status_filter not in('','ok','failed','rate_limited','degraded')
  or (country_filter not in('','__unknown__') and country_filter !~ '^[A-Z]{2}$')
 then raise exception 'PORTAL_ACCESS_REPORT_INVALID_FILTER';end if;
 until_time:=least(until_time,anchor);

 with base as materialized (
  select l.id,l.created_at,l.invite_id,l.party_type,left(l.email,320) email,
   coalesce(nullif(left(l.details->>'party_name',200),''),i.party_name) party_name,
   l.event_type,l.status,left(l.ip_address,64) ip_address,l.country_code,l.country_source,
   left(l.details->>'reason',500) reason,
   l.event_type='portal_login' and coalesce(l.details->>'auth_method','')='' is_legacy
  from public.portal_audit_logs l
  left join public.portal_invites i on i.id=l.invite_id and i.organization_id=l.organization_id
  where l.organization_id=org
   and l.event_type in('portal_login','portal_logout','portal_session_resume','portal_session_rejected')
   and l.created_at>=since_time and l.created_at<until_time
   and (input_invite_id is null or l.invite_id=input_invite_id)
   and (event_filter='' or l.event_type=event_filter)
   and (status_filter='' or l.status=status_filter)
   and (search_term='' or position(lower(search_term) in lower(coalesce(l.email,'')))>0
    or position(lower(search_term) in lower(coalesce(i.party_name,'')))>0
    or position(lower(search_term) in lower(coalesce(l.ip_address,'')))>0)
 ), filtered as materialized (
  select * from base where country_filter=''
   or (country_filter='__unknown__' and country_code is null)
   or country_code=country_filter
 ), page_rows as (
  select * from filtered order by created_at desc,id desc
  limit page_size offset (page_number-1)::bigint*page_size
 ), countries as (
  select coalesce(country_code,'__unknown__') code,count(*) count from base
  group by country_code
 )
 select jsonb_build_object(
  'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id desc) from page_rows p),'[]'::jsonb),
  'total',(select count(*) from filtered),
  'page',page_number,'pageSize',page_size,'asOf',anchor,
  'parties',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',coalesce(nullif(p.party_name,''),p.email)) order by p.party_name,p.id)
   from public.portal_invites p where p.organization_id=org),'[]'::jsonb),
  'countries',coalesce((select jsonb_agg(to_jsonb(c) order by c.count desc,c.code) from countries c),'[]'::jsonb)
 ) into result;
 return result;
end;
$function$;
revoke all on function public.admin_portal_access_report(timestamptz,timestamptz,integer,integer,text,uuid,text,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.admin_portal_access_report(timestamptz,timestamptz,integer,integer,text,uuid,text,text,text,timestamptz) to authenticated;
notify pgrst,'reload schema';
