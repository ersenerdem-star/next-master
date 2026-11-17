set lock_timeout='500ms';
set statement_timeout='5s';
create table public.catalog_elring_completion_jobs (
 run_id uuid not null references public.catalog_import_runs(id),
 phase text not null check(phase in ('images','enrichment','lifecycle','fitment')),
 organization_id uuid not null references public.organizations(id),
 source_id uuid not null references public.catalog_external_sources(id),
 brand_id uuid not null references public.brands(id),
 manifest_fingerprint text not null,
 approval_reference text not null check(length(trim(approval_reference))>0),
 approved_until timestamptz not null,
 status text not null default 'approved' check(status in ('approved','running','paused','completed')),
 cursor integer not null default -1,
 processed integer not null default 0,
 changed integer not null default 0,
 totals jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now(),
 primary key(run_id,phase)
);
create table public.catalog_elring_completion_events (
 run_id uuid not null,
 phase text not null,
 row_index integer not null,
 organization_id uuid not null,
 product_id uuid not null references public.catalog_products(id),
 product_code text not null,
 before_fields jsonb not null,
 after_fields jsonb not null,
 outcome text not null,
 evidence_fingerprint text not null,
 created_at timestamptz not null default now(),
 primary key(run_id,phase,row_index),
 foreign key(run_id,phase) references public.catalog_elring_completion_jobs(run_id,phase)
);
alter table public.catalog_elring_completion_jobs enable row level security;
alter table public.catalog_elring_completion_events enable row level security;
revoke all on public.catalog_elring_completion_jobs,public.catalog_elring_completion_events from public,anon,authenticated,service_role;
grant select on public.catalog_elring_completion_jobs,public.catalog_elring_completion_events to service_role;

create function public.run_elring_completion_batch(input_run_id uuid,input_phase text,input_batch_size integer default 25)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='3s' set lock_timeout='250ms'
as $$
declare
 j public.catalog_elring_completion_jobs%rowtype;
 r public.catalog_import_runs%rowtype;
 s public.catalog_external_sources%rowtype;
 p public.catalog_products%rowtype;
 staged record; v_candidate text; result jsonb:='{}'::jsonb;
 before_map jsonb:='{}'::jsonb; before_value jsonb; after_value jsonb;
 scanned integer:=0; changed_rows integer:=0; last_row integer; has_more boolean;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if input_phase is null or input_phase not in ('images','enrichment','lifecycle')
  or input_batch_size is null or input_batch_size not between 1 and 25 then raise exception 'Invalid completion batch'; end if;
 select * into j from public.catalog_elring_completion_jobs where run_id=input_run_id and phase=input_phase for update;
 if j.run_id is null or j.status='paused' or j.approved_until<now() then raise exception 'Completion approval missing or expired'; end if;
 select * into r from public.catalog_import_runs where id=j.run_id and organization_id=j.organization_id;
 select * into s from public.catalog_external_sources where id=j.source_id and organization_id=j.organization_id for update;
 if r.status is distinct from 'staged' or r.input_scope->>'source_key' is distinct from 'tecalliance_elring'
  or r.input_scope->>'collection_verified' is distinct from 'true'
  or r.input_scope->>'manifest_fingerprint' is distinct from j.manifest_fingerprint
  or s.source_key is distinct from 'tecalliance_elring' or s.is_active is distinct from false
  or s.license_posture is distinct from 'allowed' or s.metadata->>'internal_catalog_persistence_allowed' is distinct from 'true'
  or not exists(select 1 from public.brands where id=j.brand_id and organization_id=j.organization_id and lower(name)='elring')
  or not exists(select 1 from public.catalog_provider_stage_publications where run_id=j.run_id and brand_id=j.brand_id
   and source_id=j.source_id and status='completed' and processed_rows=r.staged_rows)
 then raise exception 'Elring completion scope mismatch'; end if;
 if j.status='completed' then return to_jsonb(j); end if;
 create temporary table elring_completion_window on commit drop as
 select st.* from public.catalog_import_stage st
 where st.run_id=j.run_id and st.organization_id=j.organization_id and st.row_index>j.cursor
  and (input_phase<>'images' or exists(select 1 from public.catalog_elring_image_events e
   where e.run_id=st.run_id and e.row_index=st.row_index and e.outcome='product_missing'))
 order by st.row_index limit input_batch_size;
 for staged in select * from elring_completion_window order by row_index loop
  if staged.source_key is distinct from 'tecalliance_elring'
   or staged.source_payload->'raw'->>'mfrName' is distinct from 'ELRING'
   or staged.source_payload->'raw'->>'dataSupplierId' is distinct from '10'
   or staged.source_payload->'raw'->>'articleNumber' is distinct from staged.product_code
  then raise exception 'Elring evidence mismatch'; end if;
  select * into p from public.catalog_products where organization_id=j.organization_id and brand_id=j.brand_id
   and normalized_code=staged.normalized_code for update;
  if p.id is null then raise exception 'Published Elring product missing'; end if;
  before_value:=jsonb_build_object('description',p.description,'weight_kg',p.weight_kg,'origin',p.origin,
   'hs_code',p.hs_code,'ean',p.ean,'oem_no',p.oem_no,'dimensions',p.dimensions,'vehicle',p.vehicle,
   'vehicle_model',p.vehicle_model,'market_segment',p.market_segment,'image_url',p.image_url,
   'lifecycle_status',p.lifecycle_status,'lifecycle_note',p.lifecycle_note);
  before_map:=before_map||jsonb_build_object(staged.row_index::text,before_value);
  if input_phase='images' then
   v_candidate:=nullif(trim(staged.source_payload->'fields'->>'image_url'),'');
   if v_candidate is null or v_candidate !~ '^https://digital-assets\.tecalliance\.services/images/(50|100|200|400|800|1600|3200)/[a-f0-9]{40}\.(jpg|png|jpeg|webp|gif)$'
    or not exists(select 1 from public.catalog_elring_image_events e where e.run_id=j.run_id and e.row_index=staged.row_index
     and e.outcome='product_missing' and e.product_code=staged.product_code and e.candidate=v_candidate
     and e.evidence_fingerprint=staged.source_fingerprint)
    or not exists(select 1 from jsonb_array_elements(staged.source_payload->'raw'->'images') im
     where im->>'assetSource'='article' and v_candidate in (im->>'imageURL50',im->>'imageURL100',im->>'imageURL200',im->>'imageURL400',im->>'imageURL800',im->>'imageURL1600',im->>'imageURL3200'))
   then raise exception 'Deferred image evidence mismatch'; end if;
   update public.catalog_products set image_url=v_candidate,updated_at=now()
    where id=p.id and organization_id=j.organization_id and nullif(trim(image_url),'') is null;
  end if;
  scanned:=scanned+1; last_row:=staged.row_index;
 end loop;
 if scanned>0 and input_phase in ('enrichment','lifecycle') then
  -- Activation is invisible outside this transaction and is rolled back on error.
  update public.catalog_external_sources set is_active=true where id=j.source_id;
  if input_phase='enrichment' then
   result:=public.enrich_elring_provider_stage_batch(j.run_id,j.brand_id,j.cursor+1,input_batch_size);
  else
   result:=public.apply_elring_provider_lifecycle_batch(j.run_id,j.brand_id,j.cursor+1,input_batch_size);
  end if;
  if (result->>'processed')::integer is distinct from scanned then raise exception 'Completion cardinality mismatch'; end if;
  update public.catalog_external_sources set is_active=false where id=j.source_id;
 end if;
 for staged in select * from elring_completion_window order by row_index loop
  select * into p from public.catalog_products where organization_id=j.organization_id and brand_id=j.brand_id
   and normalized_code=staged.normalized_code;
  before_value:=before_map->staged.row_index::text;
  after_value:=jsonb_build_object('description',p.description,'weight_kg',p.weight_kg,'origin',p.origin,
   'hs_code',p.hs_code,'ean',p.ean,'oem_no',p.oem_no,'dimensions',p.dimensions,'vehicle',p.vehicle,
   'vehicle_model',p.vehicle_model,'market_segment',p.market_segment,'image_url',p.image_url,
   'lifecycle_status',p.lifecycle_status,'lifecycle_note',p.lifecycle_note);
  if before_value is distinct from after_value then changed_rows:=changed_rows+1; end if;
  insert into public.catalog_elring_completion_events(run_id,phase,row_index,organization_id,product_id,product_code,
   before_fields,after_fields,outcome,evidence_fingerprint)
  values(j.run_id,input_phase,staged.row_index,j.organization_id,p.id,p.product_code,before_value,after_value,
   case when before_value is distinct from after_value then 'changed' else 'preserved_or_source_missing' end,staged.source_fingerprint);
 end loop;
 select exists(select 1 from public.catalog_import_stage st where st.run_id=j.run_id and st.row_index>coalesce(last_row,j.cursor)
  and (input_phase<>'images' or exists(select 1 from public.catalog_elring_image_events e where e.run_id=st.run_id
   and e.row_index=st.row_index and e.outcome='product_missing'))) into has_more;
 update public.catalog_elring_completion_jobs set cursor=coalesce(last_row,j.cursor),processed=j.processed+scanned,
  changed=j.changed+changed_rows,status=case when has_more then 'running' else 'completed' end,updated_at=now(),
  totals=jsonb_build_object('relations_inserted',coalesce((j.totals->>'relations_inserted')::integer,0)+coalesce((result->>'relations_inserted')::integer,0),
   'discontinued_applied',coalesce((j.totals->>'discontinued_applied')::integer,0)+coalesce((result->>'discontinued_applied')::integer,0),
   'rejected_relations',coalesce((j.totals->>'rejected_relations')::integer,0)+coalesce((result->>'rejected_relations')::integer,0),
   'no_explicit_signal',coalesce((j.totals->>'no_explicit_signal')::integer,0)+coalesce((result->>'no_explicit_signal')::integer,0))
 where run_id=j.run_id and phase=input_phase returning * into j;
 return to_jsonb(j);
end $$;
revoke all on function public.run_elring_completion_batch(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.run_elring_completion_batch(uuid,text,integer) to service_role;
notify pgrst,'reload schema';
