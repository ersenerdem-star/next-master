-- Publication-bound, resumable catalogue projection. No existing data is backfilled.
create table supplier_price_ingestion_internal.catalog_enrichment_control (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false
);
insert into supplier_price_ingestion_internal.catalog_enrichment_control values(true,false);
create table supplier_price_ingestion_internal.catalog_enrichment_jobs (
 id uuid primary key default gen_random_uuid(), publication_id uuid not null unique references public.supplier_price_publications(id),
 release_id uuid not null references public.supplier_price_releases(id), organization_id uuid not null,
 supplier_id uuid not null, brand_id uuid not null, source_date date, source_sha256 text not null,
 total_rows bigint not null, phase text not null default 'file' check(phase in ('file','official')),
 status text not null default 'queued' check(status in ('queued','running','completed','completed_missing','review_required','superseded','failed')),
 cursor bigint not null default 0, processed_rows bigint not null default 0,
 changed_products bigint not null default 0, review_rows bigint not null default 0,
 official_checked bigint not null default 0, missing_rows bigint not null default 0,
 lease_token uuid, lease_until timestamptz, attempts integer not null default 0, consecutive_errors integer not null default 0,
 error_code text, error_source_row bigint, error_provider text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index catalog_enrichment_ready on supplier_price_ingestion_internal.catalog_enrichment_jobs(created_at,id)
 where status in ('queued','running');
create index catalog_enrichment_release on supplier_price_ingestion_internal.catalog_enrichment_jobs(organization_id,release_id);
create table supplier_price_ingestion_internal.catalog_enrichment_changes (
 job_id uuid not null references supplier_price_ingestion_internal.catalog_enrichment_jobs(id),
 phase text not null, source_row_number bigint not null, product_code text not null,
 product_id uuid, before_values jsonb not null, patch jsonb not null, issues jsonb not null,
 evidence jsonb not null, missing_fields jsonb not null default '[]', created_at timestamptz not null default now(),
 primary key(job_id,phase,source_row_number)
);
create table supplier_price_ingestion_internal.catalog_enrichment_fields (
 product_id uuid not null references public.catalog_products(id) on delete cascade, field text not null,
 applied_value jsonb, source_date date, job_id uuid not null references supplier_price_ingestion_internal.catalog_enrichment_jobs(id),
 primary key(product_id,field)
);
create index catalog_enrichment_issues on supplier_price_ingestion_internal.catalog_enrichment_changes(job_id,phase,source_row_number)
 where jsonb_array_length(issues)>0 or jsonb_array_length(missing_fields)>0;
do $$declare t text;begin
 foreach t in array array['catalog_enrichment_control','catalog_enrichment_jobs','catalog_enrichment_changes','catalog_enrichment_fields'] loop
 execute format('alter table supplier_price_ingestion_internal.%I enable row level security',t);
 execute format('revoke all on supplier_price_ingestion_internal.%I from public,anon,authenticated,service_role',t);
 end loop;
end$$;

create function supplier_price_ingestion_internal.queue_catalog_enrichment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_control where singleton and enabled) then return new;end if;
 if not exists(select 1 from public.supplier_price_publications p where p.id=new.publication_id and p.release_id=new.release_id
  and p.organization_id=new.organization_id and p.brand_id=new.brand_id and p.supplier_id=new.supplier_id and p.status='published') then return new;end if;
 insert into supplier_price_ingestion_internal.catalog_enrichment_jobs(publication_id,release_id,organization_id,supplier_id,brand_id,source_date,source_sha256,total_rows)
 select new.publication_id,r.id,r.organization_id,r.supplier_id,r.brand_id,r.source_date,r.source_file_sha256,r.total_rows
 from public.supplier_price_releases r where r.id=new.release_id and r.source_file_sha256~'^[0-9a-f]{64}$'
 on conflict(publication_id) do nothing;
 return new;
end$$;
revoke all on function supplier_price_ingestion_internal.queue_catalog_enrichment() from public,anon,authenticated,service_role;
create trigger supplier_publication_catalog_enrichment after insert or update of publication_id,release_id
 on public.supplier_current_price_pointers for each row execute function supplier_price_ingestion_internal.queue_catalog_enrichment();

create function supplier_price_ingestion_internal.catalog_job(input_job_id uuid,input_token uuid)
returns supplier_price_ingestion_internal.catalog_enrichment_jobs
language plpgsql security definer set search_path='' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
 if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' and coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_ENRICHMENT_SERVICE_REQUIRED';end if;
 if not exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_control where singleton and enabled) then raise exception 'CATALOG_ENRICHMENT_DISABLED';end if;
 select * into j from supplier_price_ingestion_internal.catalog_enrichment_jobs where id=input_job_id for update;
 if not found or j.lease_token is distinct from input_token or j.lease_until<=clock_timestamp() or j.status<>'running' then raise exception 'CATALOG_ENRICHMENT_LEASE_LOST';end if;
 perform 1 from public.supplier_current_price_pointers p join public.supplier_price_publications pub on pub.id=p.publication_id
  and pub.release_id=p.release_id and pub.organization_id=p.organization_id and pub.supplier_id=p.supplier_id and pub.brand_id=p.brand_id
 where p.organization_id=j.organization_id and p.brand_id=j.brand_id and p.supplier_id=j.supplier_id
  and p.publication_id=j.publication_id and p.release_id=j.release_id and pub.status='published' for share of p;
 if not found then
  update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='superseded',lease_token=null,lease_until=null,updated_at=now() where id=j.id;
  j.status:='superseded';return j;
 end if;
 if not exists(select 1 from public.supplier_price_releases r where r.id=j.release_id and r.source_file_sha256=j.source_sha256) then raise exception 'CATALOG_ENRICHMENT_SOURCE_CHANGED';end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set lease_until=clock_timestamp()+interval '120 seconds',updated_at=now() where id=j.id;
 return j;
end$$;
revoke all on function supplier_price_ingestion_internal.catalog_job(uuid,uuid) from public,anon,authenticated,service_role;

create function public.claim_supplier_catalog_enrichment() returns jsonb
language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;token uuid:=gen_random_uuid();
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_ENRICHMENT_SERVICE_REQUIRED';end if;
 if not exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_control where singleton and enabled) then return jsonb_build_object('status','disabled');end if;
 if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('supplier-catalog-enrichment-consumer-v1',0))
  or exists(select 1 from supplier_price_ingestion_internal.catalog_enrichment_jobs where status='running' and lease_until>clock_timestamp()) then return jsonb_build_object('status','empty');end if;
 select * into j from supplier_price_ingestion_internal.catalog_enrichment_jobs
 where status in ('queued','running') and (lease_until is null or lease_until<clock_timestamp()) order by created_at,id for update skip locked limit 1;
 if not found then return jsonb_build_object('status','empty');end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='running',lease_token=token,
  lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=now() where id=j.id;
 return jsonb_build_object('status','claimed','jobId',j.id,'token',token,'releaseId',j.release_id,'phase',j.phase,
  'brandId',j.brand_id,'brand',(select name from public.brands where id=j.brand_id and organization_id=j.organization_id));
end$$;

create function public.read_supplier_catalog_enrichment_batch(input_job_id uuid,input_token uuid)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;result jsonb;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 -- Give active source ingestion priority; no cursor or product changes are lost.
 if exists(select 1 from public.supplier_price_release_batches b join public.supplier_price_releases rel on rel.id=b.release_id
  where rel.organization_id=j.organization_id and b.status='running' and b.lease_expires_at>clock_timestamp()) then
  update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='queued',lease_token=null,lease_until=now()+interval '30 seconds',updated_at=now() where id=j.id;
  return jsonb_build_object('status','deferred');
 end if;
 with source as materialized (
  select r.* from public.supplier_price_release_rows r where r.release_id=j.release_id and r.source_row_number>j.cursor
  order by r.source_row_number limit case when j.phase='file' then 500 else 3 end
 )
 select jsonb_agg(jsonb_build_object('rowNumber',r.source_row_number,'code',r.product_code,'rowStatus',r.row_status,
 'source',jsonb_build_object('description',r.description,'description_tr',r.description_tr,'oem_no',r.oem_no,'ean',r.ean,
 'vehicle',r.vehicle,'vehicle_model',r.vehicle_model,'market_segment',r.market_segment,'dimensions',r.dimensions,'weight',r.weight,'origin',r.origin,'tariff',r.tariff),
 'existing',coalesce((select jsonb_build_object('id',c.id,'description',c.description,'description_tr',c.description_tr,'oem_no',c.oem_no,'ean',c.ean,
 'vehicle',c.vehicle,'vehicle_model',c.vehicle_model,'market_segment',c.market_segment,'weight_kg',c.weight_kg,'dimensions',c.dimensions,'origin',c.origin,'hs_code',c.hs_code)
  from public.catalog_products c where c.organization_id=j.organization_id and c.brand_id=j.brand_id and public.normalize_catalog_product_code(c.product_code)=r.normalized_code limit 1),'{}'::jsonb),
 'fieldState',coalesce((select jsonb_object_agg(f.field,jsonb_build_object('applied_value',f.applied_value,'source_date',f.source_date))
  from supplier_price_ingestion_internal.catalog_enrichment_fields f join public.catalog_products c on c.id=f.product_id
  where c.organization_id=j.organization_id and c.brand_id=j.brand_id and public.normalize_catalog_product_code(c.product_code)=r.normalized_code),'{}'::jsonb),
 'conflicts',coalesce((select jsonb_agg(field) from (select 'origin' field where nullif(btrim(r.origin),'') is not null and exists(
   select 1 from public.supplier_current_price_pointers ptr join public.supplier_price_publications p on p.id=ptr.publication_id and p.status='published'
   join public.supplier_price_release_rows other on other.release_id=ptr.release_id and other.normalized_code=r.normalized_code
   where ptr.organization_id=j.organization_id and ptr.brand_id=j.brand_id and other.row_status='accepted'
    and nullif(btrim(other.origin),'') is not null and upper(btrim(other.origin))<>upper(btrim(r.origin)))
  union all select 'hs_code' where nullif(btrim(r.tariff),'') is not null and exists(
   select 1 from public.supplier_current_price_pointers ptr join public.supplier_price_publications p on p.id=ptr.publication_id and p.status='published'
   join public.supplier_price_release_rows other on other.release_id=ptr.release_id and other.normalized_code=r.normalized_code
   where ptr.organization_id=j.organization_id and ptr.brand_id=j.brand_id and other.row_status='accepted'
    and nullif(btrim(other.tariff),'') is not null and regexp_replace(other.tariff,'[.[:space:]-]','','g')<>regexp_replace(r.tariff,'[.[:space:]-]','','g'))) conflict_fields),'[]'::jsonb)) order by r.source_row_number)
 into result from source r;
 if result is null then
  if j.phase='file' then
   update supplier_price_ingestion_internal.catalog_enrichment_jobs set phase='official',cursor=0,updated_at=now() where id=j.id;
   return jsonb_build_object('status','next_phase','phase','official');
  end if;
  update supplier_price_ingestion_internal.catalog_enrichment_jobs set status=case when review_rows>0 then 'review_required' when missing_rows>0 then 'completed_missing' else 'completed' end,
   lease_token=null,lease_until=null,updated_at=now() where id=j.id;
  return jsonb_build_object('status','completed');
 end if;
 return jsonb_build_object('status','batch','phase',j.phase,'cursor',j.cursor,'rows',result,'sourceDate',j.source_date,'sourceSha256',j.source_sha256,
  'brandId',j.brand_id,'brand',(select name from public.brands where id=j.brand_id and organization_id=j.organization_id));
end$$;

create function public.apply_supplier_catalog_enrichment_batch(input_job_id uuid,input_token uuid,input_phase text,input_cursor bigint,input_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='2s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;r public.supplier_price_release_rows%rowtype;c public.catalog_products%rowtype;
 entry jsonb;patch jsonb;issues jsonb;before_values jsonb;proof jsonb;item record;v_code text;v_cursor bigint;v_inserted boolean;v_count integer:=0;changed integer:=0;reviews integer:=0;missing integer:=0;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 if j.phase<>input_phase or j.cursor<>input_cursor then raise exception 'CATALOG_ENRICHMENT_CURSOR_CHANGED';end if;
 if jsonb_typeof(input_rows)<>'array' or jsonb_array_length(input_rows) not between 1 and 500 or octet_length(input_rows::text)>3000000 then raise exception 'CATALOG_ENRICHMENT_BATCH_INVALID';end if;
 -- Complete prefix only: a caller cannot advance past an unprocessed source row.
 if (select array_agg((e->>'rowNumber')::bigint order by ord) from jsonb_array_elements(input_rows) with ordinality as x(e,ord)) is distinct from
  (select array_agg(x.source_row_number order by x.source_row_number) from (select source_row_number from public.supplier_price_release_rows
   where release_id=j.release_id and source_row_number>j.cursor order by source_row_number limit jsonb_array_length(input_rows))x) then raise exception 'CATALOG_ENRICHMENT_PREFIX_INVALID';end if;
 v_cursor:=j.cursor;
 for entry in select value from jsonb_array_elements(input_rows) loop
  select * into r from public.supplier_price_release_rows where release_id=j.release_id and source_row_number=(entry->>'rowNumber')::bigint;
  v_cursor:=r.source_row_number;v_count:=v_count+1;v_code:=r.normalized_code;
  if r.row_status<>'accepted' or v_code<>public.normalize_catalog_product_code(r.product_code) then reviews:=reviews+1;continue;end if;
  patch:=coalesce(entry->'patch','{}');issues:=coalesce(entry->'issues','[]');proof:=coalesce(entry->'evidence','{}');
  if jsonb_typeof(patch)<>'object' or jsonb_typeof(issues)<>'array' or jsonb_typeof(proof)<>'object' or octet_length(entry::text)>64000
   or exists(select 1 from jsonb_object_keys(patch) k where k not in ('description','description_tr','oem_no','vehicle','vehicle_model','ean','market_segment','weight_kg','dimensions','origin','hs_code'))
   or exists(select 1 from jsonb_each(patch) k where k.value='null'::jsonb or (jsonb_typeof(k.value)='string' and btrim(k.value#>>'{}')='')) then raise exception 'CATALOG_ENRICHMENT_PATCH_INVALID';end if;
  if j.phase='official' and patch<>'{}' and (proof->>'authority'<>'official' or proof->>'code'<>v_code or proof->>'brandId'<>j.brand_id::text
    or coalesce(proof->>'sourceUrl','')!~'^https://' or coalesce(proof->>'fingerprint','')!~'^[0-9a-f]{64}$') then raise exception 'CATALOG_ENRICHMENT_EVIDENCE_REQUIRED';end if;
  select * into c from public.catalog_products cp where cp.organization_id=j.organization_id and cp.brand_id=j.brand_id
   and public.normalize_catalog_product_code(cp.product_code)=v_code order by cp.id limit 1 for update;
  if c.id is not null and c.id::text is distinct from entry->'existing'->>'id' then raise exception 'CATALOG_ENRICHMENT_PRODUCT_CHANGED';end if;
  before_values:=coalesce(to_jsonb(c),'{}');
  for item in select key,value from jsonb_each(coalesce(entry->'existing','{}')) where key<>'id' loop
   if (before_values->item.key) is distinct from item.value then raise exception 'CATALOG_ENRICHMENT_PRODUCT_CHANGED';end if;
  end loop;
  v_inserted:=false;
  begin
   if c.id is null and j.phase='file' then
    insert into public.catalog_products(organization_id,brand_id,product_code) values(j.organization_id,j.brand_id,r.product_code) returning * into c;
    if public.normalize_catalog_product_code(c.product_code)<>v_code then raise check_violation using message='CATALOG_ENRICHMENT_IDENTITY_CONFLICT';end if;
    v_inserted:=true;
   end if;
   if c.id is not null and patch<>'{}' then
    -- Official observations complete missing values only, with additive identifiers.
    if j.phase='official' and exists(select 1 from jsonb_each(patch) x where x.key not in ('oem_no','vehicle','vehicle_model')
     and nullif(btrim(coalesce(before_values->>x.key,'')),'') is not null) then raise exception 'CATALOG_ENRICHMENT_OFFICIAL_OVERWRITE_DENIED';end if;
    update public.catalog_products cp set
     description=case when patch?'description' then patch->>'description' else cp.description end,
     description_tr=case when patch?'description_tr' then patch->>'description_tr' else cp.description_tr end,
     oem_no=case when patch?'oem_no' then patch->>'oem_no' else cp.oem_no end,
     vehicle=case when patch?'vehicle' then patch->>'vehicle' else cp.vehicle end,
     vehicle_model=case when patch?'vehicle_model' then patch->>'vehicle_model' else cp.vehicle_model end,
     ean=case when patch?'ean' then patch->>'ean' else cp.ean end,
     market_segment=case when patch?'market_segment' then patch->>'market_segment' else cp.market_segment end,
     weight_kg=case when patch?'weight_kg' then (patch->>'weight_kg')::numeric else cp.weight_kg end,
     dimensions=case when patch?'dimensions' then patch->'dimensions' else cp.dimensions end,
     origin=case when patch?'origin' then patch->>'origin' else cp.origin end,
     hs_code=case when patch?'hs_code' then patch->>'hs_code' else cp.hs_code end,updated_at=now() where cp.id=c.id returning cp.* into c;
    select jsonb_object_agg(k,to_jsonb(c)->k) into patch from jsonb_object_keys(patch) k;
    for item in select key,value from jsonb_each(patch) loop
     insert into supplier_price_ingestion_internal.catalog_enrichment_fields(product_id,field,applied_value,source_date,job_id)
      values(c.id,item.key,item.value,j.source_date,j.id) on conflict(product_id,field) do update set
      applied_value=excluded.applied_value,source_date=excluded.source_date,job_id=excluded.job_id;
    end loop;
   end if;
  exception when unique_violation or check_violation then
   c.id:=null;v_inserted:=false;patch:='{}';issues:=issues||jsonb_build_array(jsonb_build_object('field','product_code','code','CATALOG_IDENTITY_OR_VALUE_CONFLICT'));
  end;
  if v_inserted or patch<>'{}' then changed:=changed+1;end if;
  if jsonb_array_length(issues)>0 then reviews:=reviews+1;end if;
  if coalesce((entry->>'missing')::boolean,false) then missing:=missing+1;end if;
  if v_inserted or patch<>'{}' or jsonb_array_length(issues)>0 or proof<>'{}' or coalesce((entry->>'missing')::boolean,false) then
   insert into supplier_price_ingestion_internal.catalog_enrichment_changes(job_id,phase,source_row_number,product_code,product_id,before_values,patch,issues,evidence,missing_fields)
    values(j.id,j.phase,r.source_row_number,r.product_code,c.id,coalesce(entry->'existing','{}'),patch,issues,
     proof||jsonb_build_object('releaseId',j.release_id,'sourceSha256',j.source_sha256,'sourceDate',j.source_date),coalesce(entry->'missingFields','[]'));
  end if;
 end loop;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set cursor=v_cursor,
  processed_rows=processed_rows+case when j.phase='file' then v_count else 0 end,
  official_checked=official_checked+case when j.phase='official' then v_count else 0 end,
  changed_products=changed_products+changed,review_rows=review_rows+reviews,missing_rows=missing_rows+missing,consecutive_errors=0,error_code=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','applied','cursor',v_cursor,'rows',v_count);
end$$;

create function public.release_supplier_catalog_enrichment(input_job_id uuid,input_token uuid,input_error text default null,input_error_row bigint default null,input_error_provider text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status=case when input_error is not null and consecutive_errors>=9 then 'failed' else 'queued' end,
  consecutive_errors=case when input_error is null then consecutive_errors else consecutive_errors+1 end,
  error_code=case when input_error is null then null when input_error in ('OFFICIAL_SOURCE_TIMEOUT','OFFICIAL_SOURCE_RATE_LIMIT','OFFICIAL_SOURCE_ACCESS_DENIED','OFFICIAL_SOURCE_UNAVAILABLE','CATALOG_ENRICHMENT_PRODUCT_CHANGED') then input_error else 'CATALOG_ENRICHMENT_RETRY_REQUIRED' end,
  error_source_row=case when exists(select 1 from public.supplier_price_release_rows where release_id=j.release_id and source_row_number=input_error_row) then input_error_row else null end,
  error_provider=case when input_error_provider~'^[a-z][a-z0-9_]{1,79}$' then input_error_provider else null end,
  lease_token=null,lease_until=case when input_error is null then null else now()+interval '2 minutes' end,updated_at=now() where id=j.id;
 return jsonb_build_object('status','released');
end$$;

create function public.finish_supplier_catalog_without_official_source(input_job_id uuid,input_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
 j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
 if j.status='superseded' then return jsonb_build_object('status','superseded');end if;
 if j.phase<>'official' then raise exception 'CATALOG_ENRICHMENT_PHASE_INVALID';end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='review_required',
  error_code='OFFICIAL_SOURCE_NOT_CONFIGURED',lease_token=null,lease_until=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','review_required');
end$$;

create function public.get_supplier_catalog_enrichment_status(input_release_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=public.current_profile_org_id();
begin
 if auth.uid() is null or org is null or not exists(select 1 from public.profiles where id=auth.uid() and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'CATALOG_ENRICHMENT_ADMIN_REQUIRED';end if;
 if cardinality(input_release_ids)>25 then raise exception 'CATALOG_ENRICHMENT_PAGE_LIMIT';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('releaseId',j.release_id,'status',j.status,'phase',j.phase,'totalRows',j.total_rows,
 'processedRows',j.processed_rows,'changedProducts',j.changed_products,'reviewRows',j.review_rows,'officialChecked',j.official_checked,
 'missingRows',j.missing_rows,'errorCode',j.error_code,'errorSourceRow',j.error_source_row,'errorProvider',j.error_provider,'updatedAt',j.updated_at)) from supplier_price_ingestion_internal.catalog_enrichment_jobs j
 where j.organization_id=org and j.release_id=any(input_release_ids)),'[]'::jsonb);
end$$;

create function public.get_supplier_catalog_enrichment_details(input_release_id uuid,input_after_phase text default '',input_after_row bigint default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare org uuid:=public.current_profile_org_id();result jsonb;
begin
 if auth.uid() is null or org is null or not exists(select 1 from public.profiles where id=auth.uid() and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'CATALOG_ENRICHMENT_ADMIN_REQUIRED';end if;
 if input_after_phase not in ('','file','official') or input_after_row<0 then raise exception 'CATALOG_ENRICHMENT_CURSOR_INVALID';end if;
 select jsonb_agg(to_jsonb(x) order by phase,source_row_number) into result from (
  select c.phase,c.source_row_number,c.product_code,c.before_values,c.patch,c.issues,c.missing_fields,c.evidence->>'sourceUrl' source_url
  from supplier_price_ingestion_internal.catalog_enrichment_changes c join supplier_price_ingestion_internal.catalog_enrichment_jobs j on j.id=c.job_id
  where j.organization_id=org and j.release_id=input_release_id and (c.phase,c.source_row_number)>(input_after_phase,input_after_row)
  and (jsonb_array_length(c.issues)>0 or jsonb_array_length(c.missing_fields)>0) order by c.phase,c.source_row_number limit 21
 )x;
 return coalesce(result,'[]'::jsonb);
end$$;

create function public.retry_supplier_catalog_enrichment(input_release_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid:=public.current_profile_org_id();j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
 if auth.uid() is null or org is null or not exists(select 1 from public.profiles where id=auth.uid() and organization_id=org and is_active and role in ('admin','superadmin')) then raise exception 'CATALOG_ENRICHMENT_ADMIN_REQUIRED';end if;
 select * into j from supplier_price_ingestion_internal.catalog_enrichment_jobs where release_id=input_release_id and organization_id=org for update;
 if not found or j.status<>'failed' then raise exception 'CATALOG_ENRICHMENT_RETRY_NOT_AVAILABLE';end if;
 if not exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=org and p.supplier_id=j.supplier_id and p.brand_id=j.brand_id and p.publication_id=j.publication_id and p.release_id=j.release_id) then raise exception 'CATALOG_ENRICHMENT_SUPERSEDED';end if;
 update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='queued',consecutive_errors=0,error_code=null,lease_token=null,lease_until=null,updated_at=now() where id=j.id;
 return jsonb_build_object('status','queued');
end$$;

do $$declare p record;begin
 for p in select oid::regprocedure signature,proname from pg_proc where pronamespace='public'::regnamespace and proname in
 ('claim_supplier_catalog_enrichment','read_supplier_catalog_enrichment_batch','apply_supplier_catalog_enrichment_batch','release_supplier_catalog_enrichment','finish_supplier_catalog_without_official_source','get_supplier_catalog_enrichment_status','get_supplier_catalog_enrichment_details','retry_supplier_catalog_enrichment') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',p.signature);
 execute format('grant execute on function %s to %s',p.signature,case when p.proname in ('get_supplier_catalog_enrichment_status','get_supplier_catalog_enrichment_details','retry_supplier_catalog_enrichment') then 'authenticated' else 'service_role' end);
 end loop;
end$$;
