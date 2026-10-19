-- Explicit operator-reviewed quarantine; never inferred from a source 404 alone.
create table public.catalog_zf_metadata_quarantines (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 catalog_product_id uuid not null references public.catalog_products(id),
 job_id uuid not null references public.catalog_zf_jobs(id),
 item_index integer not null,
 actor_id uuid not null,
 review_reference text not null,
 before_values jsonb not null,
 after_values jsonb not null,
 created_at timestamptz not null default now(),
 unique(job_id,item_index)
);
alter table public.catalog_zf_metadata_quarantines enable row level security;
revoke all on public.catalog_zf_metadata_quarantines from public,anon,authenticated;
grant select on public.catalog_zf_metadata_quarantines to authenticated;
grant all on public.catalog_zf_metadata_quarantines to service_role;
create policy zf_quarantine_admin_read on public.catalog_zf_metadata_quarantines for select to authenticated
 using (organization_id=(select public.current_profile_org_id()) and (select public.current_profile_role())='superadmin');

create function public.quarantine_reviewed_zf_metadata(input_org uuid,input_job uuid,input_index integer,input_actor uuid,input_review text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='4s' set lock_timeout='250ms' as $$
declare j public.catalog_zf_jobs%rowtype; it public.catalog_zf_job_items%rowtype; p public.catalog_products%rowtype;
 original jsonb; prior public.catalog_zf_metadata_quarantines%rowtype; title_prefix text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if nullif(trim(input_review),'') is null or length(input_review)>500 then raise exception 'Explicit contamination review required'; end if;
 if not exists(select 1 from public.profiles where id=input_actor and organization_id=input_org and role='superadmin' and is_active) then raise exception 'Active tenant superadmin required'; end if;
 select * into j from public.catalog_zf_jobs where id=input_job and organization_id=input_org and status='completed' and manifest->>'brand'='Sachs';
 if j.id is null then raise exception 'Completed Sachs review required'; end if;
 select * into it from public.catalog_zf_job_items where job_id=j.id and organization_id=input_org and item_index=input_index;
 if it.observation->>'unavailable' is distinct from 'OFFICIAL_EXACT_MATCH_NOT_FOUND' then raise exception 'Unavailable exact source receipt required'; end if;
 original:=it.observation->'before';
 select * into p from public.catalog_products where id=(original->>'id')::uuid and organization_id=input_org for update;
 if p.id is null or p.product_code is distinct from it.product_code or not exists(select 1 from public.brands where id=p.brand_id and organization_id=input_org and name='Sachs') then raise exception 'Exact Sachs identity required'; end if;
 select * into prior from public.catalog_zf_metadata_quarantines where job_id=j.id and item_index=input_index;
 if found then return jsonb_build_object('status','already_quarantined','id',prior.id); end if;
 if to_jsonb(p)->'description' is distinct from original->'description' or to_jsonb(p)->'weight_kg' is distinct from original->'weight_kg' then
  return jsonb_build_object('status','changed_since_review');
 end if;
 title_prefix:=(regexp_match(p.description,'^\s*([0-9][A-Za-z0-9 .,/+-]*?)\s+[-–:]\s+[A-Za-z]'))[1];
 if length(regexp_replace(coalesce(title_prefix,''),'[^0-9]','','g'))<5 then raise exception 'Reviewed foreign SKU title required'; end if;
 insert into public.catalog_zf_metadata_quarantines(organization_id,catalog_product_id,job_id,item_index,actor_id,review_reference,before_values,after_values)
 values(input_org,p.id,j.id,input_index,input_actor,input_review,to_jsonb(p),jsonb_build_object('description',null,'weight_kg',null));
 update public.catalog_products set description=null,weight_kg=null,updated_at=now() where id=p.id;
 return jsonb_build_object('status','quarantined','product_code',p.product_code);
end $$;
revoke all on function public.quarantine_reviewed_zf_metadata(uuid,uuid,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.quarantine_reviewed_zf_metadata(uuid,uuid,integer,uuid,text) to service_role;
