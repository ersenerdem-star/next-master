-- Explicit operator-approved image-only source fill. Does not resume publication,
-- activate sources, replace images, disable triggers, or change review policy.
set lock_timeout = '500ms';
set statement_timeout = '5s';
create table public.catalog_elring_image_jobs (
 run_id uuid primary key references public.catalog_import_runs(id),
 organization_id uuid not null references public.organizations(id),
 source_id uuid not null references public.catalog_external_sources(id),
 brand_id uuid not null references public.brands(id),
 approval_actor text not null check(length(trim(approval_actor))>0),
 approval_reference text not null check(length(trim(approval_reference))>0),
 approved_until timestamptz not null,
 manifest_fingerprint text not null,
 status text not null default 'approved' check(status in ('approved','running','paused','completed')),
 cursor integer not null default -1,
 scanned integer not null default 0,
 applied integer not null default 0,
 updated_at timestamptz not null default now()
);
create table public.catalog_elring_image_events (
 run_id uuid not null references public.catalog_elring_image_jobs(run_id),
 row_index integer not null,
 organization_id uuid not null,
 product_id uuid references public.catalog_products(id),
 product_code text not null,
 before_value text,
 candidate text,
 outcome text not null check(outcome in ('applied','source_missing','product_missing','preserved','already_present')),
 evidence_url text not null,
 evidence_fingerprint text not null,
 created_at timestamptz not null default now(),
 primary key(run_id,row_index)
);
alter table public.catalog_elring_image_jobs enable row level security;
alter table public.catalog_elring_image_events enable row level security;
revoke all on public.catalog_elring_image_jobs,public.catalog_elring_image_events from public,anon,authenticated,service_role;
grant select on public.catalog_elring_image_jobs,public.catalog_elring_image_events to service_role;

create function public.fill_approved_elring_images(input_run_id uuid,input_batch_size integer default 25)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='3s' set lock_timeout='250ms'
as $$
declare
 j public.catalog_elring_image_jobs%rowtype;
 r public.catalog_import_runs%rowtype;
 s public.catalog_external_sources%rowtype;
 staged record;
 p public.catalog_products%rowtype;
 candidate text; outcome text; v_scanned integer:=0; v_applied integer:=0;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Service role required'; end if;
 if input_batch_size is null or input_batch_size not between 1 and 25 then raise exception 'Invalid image batch'; end if;
 select * into j from public.catalog_elring_image_jobs where run_id=input_run_id for update;
 if j.run_id is null or j.status='paused' or j.approved_until<now() then raise exception 'Image approval missing or expired'; end if;
 select * into r from public.catalog_import_runs where id=j.run_id and organization_id=j.organization_id;
 select * into s from public.catalog_external_sources where id=j.source_id and organization_id=j.organization_id;
 if r.id is null or r.input_scope->>'source_key' is distinct from 'tecalliance_elring'
  or r.input_scope->>'collection_verified' is distinct from 'true'
  or r.input_scope->>'manifest_fingerprint' is distinct from j.manifest_fingerprint
  or s.source_key is distinct from 'tecalliance_elring' or s.license_posture is distinct from 'allowed'
  or s.is_active is distinct from false
  or s.metadata->>'internal_catalog_persistence_allowed' is distinct from 'true'
  or not exists(select 1 from public.brands where id=j.brand_id and organization_id=j.organization_id and lower(name)='elring')
 then raise exception 'Elring image scope mismatch'; end if;
 if j.status='completed' then return to_jsonb(j); end if;
 for staged in select * from public.catalog_import_stage where run_id=j.run_id and organization_id=j.organization_id
  and row_index>j.cursor order by row_index limit input_batch_size
 loop
  candidate:=nullif(trim(staged.source_payload->'fields'->>'image_url'),'');
  if candidate is not null and (
    candidate !~ '^https://digital-assets\.tecalliance\.services/images/(50|100|200|400|800|1600|3200)/[a-f0-9]{40}\.(jpg|png|jpeg|webp|gif)$'
    or staged.source_key is distinct from 'tecalliance_elring'
    or staged.source_payload->'raw'->>'mfrName' is distinct from 'ELRING'
    or staged.source_payload->'raw'->>'dataSupplierId' is distinct from '10'
    or staged.source_payload->'raw'->>'articleNumber' is distinct from staged.product_code
    or staged.source_payload->'fields'->>'product_code' is distinct from staged.product_code
    or not exists(select 1 from jsonb_array_elements(staged.source_payload->'raw'->'images') im
      where im->>'assetSource'='article' and candidate in (im->>'imageURL50',im->>'imageURL100',im->>'imageURL200',im->>'imageURL400',im->>'imageURL800',im->>'imageURL1600',im->>'imageURL3200'))
   ) then raise exception 'Image evidence mismatch for %',staged.product_code; end if;
  select * into p from public.catalog_products where organization_id=j.organization_id and brand_id=j.brand_id
   and normalized_code=staged.normalized_code for update;
  outcome:=case when candidate is null then 'source_missing' when p.id is null then 'product_missing'
   when nullif(trim(p.image_url),'') is not null then case when p.image_url=candidate then 'already_present' else 'preserved' end else 'applied' end;
  if outcome='applied' then
   update public.catalog_products set image_url=candidate,updated_at=now()
    where id=p.id and organization_id=j.organization_id and nullif(trim(image_url),'') is null;
   if not found then raise exception 'Image target changed'; end if;
   v_applied:=v_applied+1;
  end if;
  insert into public.catalog_elring_image_events(run_id,row_index,organization_id,product_id,product_code,before_value,candidate,outcome,evidence_url,evidence_fingerprint)
   values(j.run_id,staged.row_index,j.organization_id,p.id,staged.product_code,p.image_url,candidate,outcome,staged.source_url,staged.source_fingerprint);
  j.cursor:=staged.row_index; v_scanned:=v_scanned+1;
 end loop;
 update public.catalog_elring_image_jobs set cursor=j.cursor,scanned=catalog_elring_image_jobs.scanned+v_scanned,
  applied=catalog_elring_image_jobs.applied+v_applied,updated_at=now(),
  status=case when not exists(select 1 from public.catalog_import_stage where run_id=j.run_id and row_index>j.cursor) then 'completed' else 'running' end
  where run_id=j.run_id returning * into j;
 return to_jsonb(j);
end;
$$;
revoke all on function public.fill_approved_elring_images(uuid,integer) from public,anon,authenticated;
grant execute on function public.fill_approved_elring_images(uuid,integer) to service_role;
notify pgrst,'reload schema';
