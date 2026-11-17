import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {preparedPortalPriceVersionInput,priceListVersionRpc} from '../../shared/prepared-price-export.mjs';

const versions=await readFile('supabase/migrations/20261023160816_prepared_price_list_artifact_versions.sql','utf8');
const admission=await readFile('supabase/migrations/20261023160946_prepared_price_list_admission_and_prewarm.sql','utf8');
const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),brand=id(2),actor=id(3),supplier=id(4),release=id(5),publication=id(6);
const scope={brandId:brand,brandName:'Fixture',priceListType:'A',marginPercent:.1,format:'xlsx',schemaVersion:4,versionContract:'publication-v1'};
async function fixture(){
 const db=new PGlite();
 await db.exec(await readFile('scripts/tests/export-quote-eligibility-pg.setup.sql','utf8'));
 await db.exec(`alter table brands add column organization_id uuid;
 alter table catalog_products add column normalized_code text;
 alter table supplier_price_release_rows add column valid_to date;
 create table suppliers(id uuid primary key,organization_id uuid,name text);
 create table supplier_prices(id uuid primary key,organization_id uuid,supplier_id uuid,brand_id uuid,
 product_code text,normalized_code text,description text,buy_price numeric,currency text,valid_from date,valid_to date,is_active boolean,updated_at timestamptz default now());
 create table organizations(id uuid primary key);create table profiles(id uuid primary key);
 create table customers(id uuid primary key,organization_id uuid,price_list_type text,price_list_margin_percent numeric,currency text,custom_fields text);
 create table customer_price_lists(id uuid primary key,organization_id uuid,list_type text,margin_percent numeric,is_active boolean,updated_at timestamptz);
 create table portal_invites(id uuid primary key,organization_id uuid,status text,customer_id uuid,access_can_view_orders boolean,allowed_brand_ids jsonb,expires_at timestamptz,seller_company_profile_id uuid);
 create schema storage;create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));`);
 await db.exec(await readFile('supabase/migrations/20261015000000_supplier_price_source_revision.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261014091652_app_export_jobs_schema_contract.sql','utf8'));
 await db.exec(versions);
 await db.exec(admission);
 await db.exec(await readFile('supabase/migrations/20261023161916_prepared_price_artifact_adoption_and_events.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261023162831_prepared_price_prewarm_failure_backoff.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261023162929_supplier_price_revision_distinct_scopes.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261023164519_prepared_price_profile_event_fairness.sql','utf8'));
 await db.query('insert into organizations values($1)',[org]);await db.query('insert into profiles values($1)',[actor]);
 await db.query('insert into brands(id,name,organization_id) values($1,\'Fixture\',$2)',[brand,org]);
 return db;
}
const version=async db=>(await db.query('select get_prepared_price_list_export_version($1,$2) v',[org,brand])).rows[0].v;
const admit=async(db,key='key',v='v1',s=scope)=>(await db.query(
 'select admit_prepared_price_list_export($1,$2,$3,$4,$5,$6,$7) result',[org,actor,'admin','admin_price_list',s,key,v])).rows[0].result;

test('price snapshot ignores unrelated enrichment but tracks identity, lifecycle, references and actual price changes',async()=>{
 const db=await fixture();try{
  await db.query('insert into catalog_products(id,organization_id,brand_id,product_code,normalized_code,lifecycle_status) values($1,$2,$3,\'A\',\'A\',\'active\')',[id(10),org,brand]);
  const a=await version(db);
  await db.query("update catalog_products set description='Better description',origin='TR',hs_code='8708',weight_kg=2,updated_at=clock_timestamp() where id=$1",[id(10)]);
  assert.equal(await version(db),a,'price snapshot descriptions wait for the next relevant price version');
  await db.query("update catalog_products set lifecycle_status='discontinued' where id=$1",[id(10)]);
  const b=await version(db);assert.notEqual(a,b);
  await db.query("update catalog_products set product_code='B',normalized_code='B' where id=$1",[id(10)]);
  const c=await version(db);assert.notEqual(b,c);
  await db.query("insert into item_code_references(id,organization_id,brand_id,old_code,new_code,is_active) values($1,$2,$3,'B','C',true)",[id(11),org,brand]);
  const d=await version(db);assert.notEqual(c,d);
  await db.query("insert into supplier_prices(id,organization_id,supplier_id,brand_id,buy_price,currency,is_active) values($1,$2,$3,$4,10,'EUR',true)",[id(12),org,supplier,brand]);
  assert.notEqual(await version(db),d);
  assert.equal(await version(db),await version(db));
 }finally{await db.close();}
});

test('unchanged dates do not invalidate, while future start and inclusive end boundaries invalidate exactly when crossed',async()=>{
 const db=await fixture();try{
  const sql=versions.match(/create function public\.get_prepared_price_list_export_version\(input_organization_id uuid,input_brand_id uuid\)([\s\S]*?)\$fn\$;/)[0];
  await db.exec(sql.replace('get_prepared_price_list_export_version(input_organization_id uuid,input_brand_id uuid)',
   'prepared_version_at(input_organization_id uuid,input_brand_id uuid,input_day date)').replaceAll('current_date','input_day'));
  const at=async day=>(await db.query('select prepared_version_at($1,$2,$3) v',[org,brand,day])).rows[0].v;
  await db.query("insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status) values($1,$2,$3,$4,$5,'published')",[publication,org,brand,supplier,release]);
  await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,brand,supplier,release,publication]);
  await db.query("insert into supplier_price_release_rows(id,release_id,product_code,normalized_code,buy_price,currency,row_status,valid_from,valid_to) values($1,$2,'A','A',10,'EUR','accepted','2026-10-20','2026-11-03'),($3,$2,'B','B',5,'EUR','accepted','2026-10-25',null)",[id(10),release,id(11)]);
  assert.equal(await at('2026-10-23'),await at('2026-10-24'));
  assert.notEqual(await at('2026-10-24'),await at('2026-10-25'));
  assert.equal(await at('2026-10-25'),await at('2026-11-03'),'end date remains inclusive');
  assert.notEqual(await at('2026-11-03'),await at('2026-11-04'));
  await db.query('delete from supplier_current_price_pointers where organization_id=$1',[org]);
  await db.query("insert into supplier_prices(id,organization_id,supplier_id,brand_id,buy_price,currency,is_active,valid_from,valid_to) values($1,$2,$3,$4,10,'EUR',true,'2026-10-25','2026-11-03')",[id(12),org,supplier,brand]);
  assert.equal(await at('2026-10-23'),await at('2026-10-24'));
  assert.notEqual(await at('2026-10-24'),await at('2026-10-25'));
  assert.notEqual(await at('2026-11-03'),await at('2026-11-04'));
 }finally{await db.close();}
});

test('same profile admission coalesces work; expired access receipt reuses identical private bytes without regenerating',async()=>{
 const db=await fixture();try{
  const first=await admit(db);assert.equal(first.cached,false);assert.equal(first.job.status,'queued');
  assert.equal((await admit(db)).job.id,first.job.id);
  const path=org+'/fixture/file.xlsx';
  await db.query("insert into storage.objects values('app-exports',$1,'{\"size\":100}')",[path]);
  await db.query("update app_export_jobs set status='finalized',row_count=12,progress_total=12,progress_done=12,byte_size=100,storage_bucket='app-exports',storage_path=$1,file_name='file.xlsx',content_type='xlsx',finalized_at=now(),expires_at='2000-01-01' where id=$2",[path,first.job.id]);
  const reused=await admit(db);assert.equal(reused.cached,true);assert.equal(reused.job.status,'finalized');
  assert.notEqual(reused.job.id,first.job.id);assert.equal(reused.job.storage_path,path);
  assert.equal((await admit(db)).job.id,reused.job.id);
  assert.equal((await db.query('select count(*) n from app_export_jobs')).rows[0].n,2);
  assert.match((await db.query('select expires_at::text t from app_export_jobs where id=$1',[first.job.id])).rows[0].t,/2000-01-01/);
  assert.equal((await admit(db,'key2','v2')).cached,false,'changed version cannot reuse old prices');
  assert.equal((await admit(db,'customer-scope','v1',{...scope,marginPercent:.2})).cached,false,'different margin never shares a receipt');
  await db.query('delete from storage.objects where name=$1',[path]);
  const missing=await admit(db);assert.equal(missing.cached,false);assert.equal(missing.job.status,'queued');
 }finally{await db.close();}
});

test('prewarm survives expiry, does not duplicate active jobs, preserves a publication arriving during a lease and is private',async()=>{
 const db=await fixture();try{
  const a=await admit(db);assert.equal((await db.query('select * from claim_prepared_price_profile()')).rows.length,0);
  await db.query("update app_export_jobs set status='finalized' where id=$1",[a.job.id]);
  await db.exec("update prepared_price_export_profiles set next_check_at='epoch'");
  const claim=()=>db.query('select * from claim_prepared_price_profile()');
  const p=(await claim()).rows[0];assert.ok(p?.lease_token);
  assert.equal((await claim()).rows.length,0);
  await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,brand,supplier,release,publication]);
  assert.equal((await db.query('select finish_prepared_price_profile($1,$2,$3) ok',[p.id,id(99),p.revision])).rows[0].ok,false);
  assert.equal((await db.query('select finish_prepared_price_profile($1,$2,$3) ok',[p.id,p.lease_token,p.revision])).rows[0].ok,true);
  const again=(await claim()).rows[0];assert.ok(again);assert.ok(again.revision>p.revision,'concurrent event was not lost');
  await db.exec("update prepared_price_export_profiles set lease_expires_at='epoch'");
  const reclaimed=(await claim()).rows[0];assert.ok(reclaimed,'a crashed tick can be reclaimed');
  await db.exec("update prepared_price_export_profiles set revision=revision+1");
  await db.query('select finish_prepared_price_profile($1,$2,$3,$4)',[reclaimed.id,reclaimed.lease_token,reclaimed.revision,'PREPARED_PRICE_REFRESH_FAILED']);
  // A failing profile must yield even if its source changes during the attempt.
  assert.equal((await claim()).rows.length,0,'failed profiles back off rather than monopolize the queue');
  for(const name of ['get_prepared_price_list_export_version(uuid,uuid)','admit_prepared_price_list_export(uuid,uuid,text,text,jsonb,text,text,boolean,text,text)','claim_prepared_price_profile()']){
   const r=(await db.query("select has_function_privilege('anon',$1,'execute') a,has_function_privilege('authenticated',$1,'execute') b,has_function_privilege('service_role',$1,'execute') s",[name])).rows[0];
   assert.deepEqual(r,{a:false,b:false,s:true});
  }
  assert.equal((await db.query("select has_table_privilege('authenticated','prepared_price_export_profiles','select') a")).rows[0].a,false);
 }finally{await db.close();}
});

test('event schedule honors future manual and published dates, retry backoff, and concurrent changes',async()=>{
 const db=await fixture();try{
  await db.exec(`create schema supplier_manual_price_internal;
   create table supplier_manual_price_internal.entries(organization_id uuid,brand_id uuid,active boolean,valid_from date);`);
  await db.exec(await readFile('supabase/migrations/20261115115050_prepared_price_event_schedule.sql','utf8'));
  await admit(db);
  await db.exec("update app_export_jobs set status='finalized'; update prepared_price_export_profiles set next_check_at='epoch'");
  const claim=async()=>(await db.query('select * from claim_prepared_price_profile()')).rows[0];
  const finish=async(p,error=null)=>db.query('select finish_prepared_price_profile($1,$2,$3,$4)',[p.id,p.lease_token,p.revision,error]);
  let p=await claim();assert.ok(p);
  await finish(p);
  let row=(await db.query("select next_check_at>now()+interval '6 days' weekly from prepared_price_export_profiles")).rows[0];
  assert.equal(row.weekly,true);
  await db.query("insert into supplier_manual_price_internal.entries values($1,$2,true,current_date+2)",[org,brand]);
  await db.exec("update prepared_price_export_profiles set next_check_at='epoch'");
  p=await claim();await finish(p,'PREPARED_PRICE_SOURCE_UNAVAILABLE');
  row=(await db.query("select next_check_at=(current_date+2)::timestamp at time zone 'UTC' due from prepared_price_export_profiles")).rows[0];
  assert.equal(row.due,true,'future manual price wakes at its UTC effective date');
  await db.query("insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status) values($1,$2,$3,$4,$5,'published')",[publication,org,brand,supplier,release]);
  await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,brand,supplier,release,publication]);
  await db.query("insert into supplier_price_release_rows(id,release_id,product_code,normalized_code,buy_price,currency,row_status,valid_from,valid_to) values($1,$2,'A','A',10,'EUR','accepted',current_date,current_date)",[id(31),release]);
  p=await claim();assert.ok(p);await finish(p);
  row=(await db.query("select next_check_at=(current_date+1)::timestamp at time zone 'UTC' due from prepared_price_export_profiles")).rows[0];
  assert.equal(row.due,true,'published end dates are inclusive');
  await db.exec("update prepared_price_export_profiles set next_check_at='epoch'");
  p=await claim();await db.exec('update prepared_price_export_profiles set revision=revision+1');await finish(p);
  assert.ok(await claim(),'event arriving during preparation is not lost');
  await db.exec("update prepared_price_export_profiles set lease_expires_at='epoch'");
  p=await claim();await finish(p,'PREPARED_PRICE_REFRESH_FAILED');
  row=(await db.query("select next_check_at>now()+interval '14 minutes' and next_check_at<now()+interval '16 minutes' retry from prepared_price_export_profiles")).rows[0];
  assert.equal(row.retry,true);
 }finally{await db.close();}
});

test('manual-only brands require an active effective price and enabled supplier',async()=>{
 const db=await fixture();try{
  await db.exec(`alter table suppliers add column price_usage_enabled boolean default true;
   create function public.supplier_price_usage_enabled(uuid,uuid) returns boolean language sql as 'select true';
   create schema supplier_manual_price_internal;
   create table supplier_manual_price_internal.entries(organization_id uuid,brand_id uuid,supplier_id uuid,active boolean,valid_from date,buy_price numeric,currency text,exact_code text,product_code text);`);
  await db.exec(await readFile('supabase/migrations/20261115115218_prepared_price_manual_brand_support.sql','utf8'));
  await db.query("insert into suppliers(id,organization_id,name) values($1,$2,'fixture')",[supplier,org]);
  await db.query("insert into supplier_manual_price_internal.entries values($1,$2,$3,true,current_date+1,10,'EUR','A','A')",[org,brand,supplier]);
  const count=async()=>(await db.query('select count(*)::int n from cloud_admin_price_list_brands($1)',[org])).rows[0].n;
  assert.equal(await count(),0,'future price is not yet effective');
  await db.exec('update supplier_manual_price_internal.entries set valid_from=current_date');
  assert.equal(await count(),1);
  await db.exec('update suppliers set price_usage_enabled=false');
  assert.equal(await count(),0,'closed supplier cannot supply a price');
  await db.exec('update suppliers set price_usage_enabled=true; update supplier_manual_price_internal.entries set active=false');
  assert.equal(await count(),0,'retired manual price is excluded');
 }finally{await db.close();}
});

test('shared price files issue isolated receipts only for identical current price scope',async()=>{
 const db=await fixture();try{
  await db.exec(await readFile('supabase/migrations/20261115124557_shared_prepared_customer_price_artifacts.sql','utf8'));
  const src=await version(db), original={...scope,sourceVersion:src,inviteId:id(21),customerId:id(22),currency:'EUR',marginPercent:10};
  const first=(await db.query("select admit_prepared_price_list_export($1,null,'portal','portal_price_list',$2,'owner-key','owner-version') result",[org,original])).rows[0].result.job;
  const path=org+'/fixture/shared.xlsx';
  await db.query("insert into storage.objects values('app-exports',$1,'{\"size\":100}')",[path]);
  await db.query("update app_export_jobs set status='finalized',row_count=12,progress_total=12,progress_done=12,byte_size=100,storage_bucket='app-exports',storage_path=$1,file_name='file.xlsx',content_type='xlsx',finalized_at=now() where id=$2",[path,first.id]);
  const recipient={...original,inviteId:id(31),customerId:id(32)};
  const adopt=async(s=recipient,key='recipient-key')=>(await db.query('select adopt_shared_portal_price_artifact($1,$2,$3,$4) result',[org,s,key,'recipient-version'])).rows[0].result;
  assert.equal(await adopt({...recipient,marginPercent:11},'different-margin'),null);
  assert.equal(await adopt({...recipient,priceListType:'B'},'different-list'),null);
  assert.equal(await adopt({...recipient,brandName:'Other'},'different-brand'),null);
  const result=await adopt();assert.equal(result.cached,true);assert.notEqual(result.job.id,first.id);
  assert.equal(result.job.scope.inviteId,recipient.inviteId);assert.equal(result.job.scope.customerId,recipient.customerId);
  assert.equal(result.job.storage_path,path);assert.equal(await adopt(),null,'existing receipt is not duplicated');
  await db.query('delete from storage.objects where name=$1',[path]);
  assert.equal(await adopt({...recipient,inviteId:id(41),customerId:id(42)},'missing'),null);
  await assert.rejects(adopt({...recipient,sourceVersion:'stale'},'stale'),/PREPARED_PRICE_SOURCE_CHANGED/);
  const acl=(await db.query("select has_function_privilege('anon','adopt_shared_portal_price_artifact(uuid,jsonb,text,text)','execute') a,has_function_privilege('authenticated','adopt_shared_portal_price_artifact(uuid,jsonb,text,text)','execute') b,has_function_privilege('service_role','adopt_shared_portal_price_artifact(uuid,jsonb,text,text)','execute') s")).rows[0];
  assert.deepEqual(acl,{a:false,b:false,s:true});
 }finally{await db.close();}
});

test('cold shared work creates one leader, isolated followers, and propagates completion or failure',async()=>{
 const db=await fixture();try{
  await db.exec(await readFile('supabase/migrations/20261115124557_shared_prepared_customer_price_artifacts.sql','utf8'));
  await db.exec(await readFile('supabase/migrations/20261115131043_shared_portal_cold_export_coalescing.sql','utf8'));
  const src=await version(db), base={...scope,sourceVersion:src,inviteId:id(21),customerId:id(22),currency:'EUR',marginPercent:10};
  const start=async(s,key)=>(await db.query('select admit_shared_portal_price_work($1,$2,$3,$4) r',[org,s,key,`version-${key}`])).rows[0].r.job;
  const a=await start(base,'a');const b=await start({...base,inviteId:id(31),customerId:id(32)},'b');
  const c=await start({...base,inviteId:id(41),customerId:id(42),marginPercent:11},'c');
  assert.equal(a.scope.sharedLeaderJobId,undefined);assert.equal(b.scope.sharedLeaderJobId,a.id);
  assert.equal(c.scope.sharedLeaderJobId,undefined,'different margin creates its own work');
  assert.equal((await start({...base,inviteId:id(31),customerId:id(32)},'b')).id,b.id,'retry returns own follower');
  const path=org+'/fixture/shared.xlsx';
  await db.query("insert into storage.objects values('app-exports',$1,'{\"size\":100}')",[path]);
  await db.query("update app_export_jobs set status='finalized',row_count=12,progress_total=12,progress_done=12,byte_size=100,storage_bucket='app-exports',storage_path=$1,file_name='file.xlsx',content_type='xlsx',finalized_at=now() where id=$2",[path,a.id]);
  const follow=(await db.query('select status,scope,storage_path from app_export_jobs where id=$1',[b.id])).rows[0];
  assert.equal(follow.status,'finalized');assert.equal(follow.storage_path,path);assert.equal(follow.scope.inviteId,id(31));
  assert.equal((await db.query('select status from app_export_jobs where id=$1',[c.id])).rows[0].status,'queued');
  const d=await start({...base,inviteId:id(51),customerId:id(52),marginPercent:11},'d');assert.equal(d.scope.sharedLeaderJobId,c.id);
  await db.query("update app_export_jobs set status='failed' where id=$1",[c.id]);
  assert.equal((await db.query('select status from app_export_jobs where id=$1',[d.id])).rows[0].status,'failed');
  const retry=await start({...base,inviteId:id(51),customerId:id(52),marginPercent:11},'d');assert.notEqual(retry.id,d.id);
  const r=(await db.query("select has_function_privilege('anon','admit_shared_portal_price_work(uuid,jsonb,text,text)','execute') a,has_function_privilege('authenticated','admit_shared_portal_price_work(uuid,jsonb,text,text)','execute') b,has_function_privilege('service_role','admit_shared_portal_price_work(uuid,jsonb,text,text)','execute') s")).rows[0];
  assert.deepEqual(r,{a:false,b:false,s:true});
 }finally{await db.close();}
});

test('cold followers fail closed on source change and recover from an expired leader',async()=>{
 const db=await fixture();try{
  await db.exec(await readFile('supabase/migrations/20261115124557_shared_prepared_customer_price_artifacts.sql','utf8'));
  await db.exec(await readFile('supabase/migrations/20261115131043_shared_portal_cold_export_coalescing.sql','utf8'));
  const src=await version(db),base={...scope,sourceVersion:src,inviteId:id(21),customerId:id(22),currency:'EUR',marginPercent:10};
  const start=async(s,key)=>(await db.query('select admit_shared_portal_price_work($1,$2,$3,$4) r',[org,s,key,`version-${key}`])).rows[0].r.job;
  const leader=await start(base,'leader');const follower=await start({...base,inviteId:id(31),customerId:id(32)},'follower');
  await db.query("insert into item_code_references(id,organization_id,brand_id,old_code,new_code,is_active) values($1,$2,$3,'OLD','NEW',true)",[id(99),org,brand]);
  await db.query("update app_export_jobs set status='finalized',row_count=1,progress_total=1,progress_done=1,byte_size=10,storage_bucket='app-exports',storage_path=$1,file_name='file.xlsx',content_type='xlsx',finalized_at=now() where id=$2",[org+'/old.xlsx',leader.id]);
  assert.equal((await db.query('select status from app_export_jobs where id=$1',[follower.id])).rows[0].status,'failed','changed source must not be relabeled as current');
  const nextVersion=await version(db),nextBase={...base,sourceVersion:nextVersion};
  const next=await start(nextBase,'next');const waiting=await start({...nextBase,inviteId:id(41),customerId:id(42)},'waiting');
  await db.query("update app_export_jobs set expires_at='2000-01-01' where id=$1",[next.id]);
  const expired=(await db.query('select fail_orphan_shared_portal_follower($1,$2) r',[org,waiting.id])).rows[0].r;
  assert.equal(expired.status,'failed');
  assert.equal((await db.query('select fail_orphan_shared_portal_follower($1,$2) r',[org,next.id])).rows[0].r,null,'producer cannot be marked as a follower');
 }finally{await db.close();}
});

test('a still-current legacy workbook is adopted without another build; a stale source fence cannot relabel it',async()=>{
 const db=await fixture();try{
  const path=org+'/old/file.xlsx';const legacyScope={...scope};delete legacyScope.versionContract;
  await db.query("insert into app_export_jobs(organization_id,requested_by,audience,export_type,scope,cache_key,data_version,status,storage_bucket,storage_path,file_name,content_type,row_count,progress_total,progress_done,byte_size,finalized_at) values($1,$2,'admin','admin_price_list',$3,'legacy-key','current-legacy-version','finalized','app-exports',$4,'old.xlsx','xlsx',12,12,12,100,now())",[org,actor,legacyScope,path]);
  await db.query("insert into storage.objects values('app-exports',$1,'{\"size\":100}')",[path]);
  const base=await version(db);const newScope={...scope,sourceVersion:base};
  const probe=(await db.query('select admit_prepared_price_list_export($1,$2,\'admin\',\'admin_price_list\',$3,\'new-key\',$4,true) r',[org,actor,newScope,base])).rows[0].r;
  assert.equal(probe.needsLegacyProbe,true);
  const result=(await db.query("select admit_prepared_price_list_export($1,$2,'admin','admin_price_list',$3,'new-key',$4,false,'legacy-key','current-legacy-version') r",[org,actor,newScope,base])).rows[0].r;
  assert.equal(result.cached,true);assert.equal(result.job.status,'finalized');assert.equal(result.job.storage_path,path);
  assert.equal(result.job.scope.versionContract,'publication-v1');assert.equal(result.job.data_version,base);
  await assert.rejects(db.query("select admit_prepared_price_list_export($1,$2,'admin','admin_price_list',$3,'wrong-key','stale',false,'legacy-key','current-legacy-version')",[org,actor,{...scope,sourceVersion:'stale'}]),/PREPARED_PRICE_SOURCE_CHANGED/);
 }finally{await db.close();}
});

test('prepared portal version uses only effective account pricing; legacy work retains its original contract',()=>{
 const context={customerId:'c',priceListType:'A',currency:'EUR',effectiveMarginA:10,effectiveMarginB:15,cPriceListIds:[]};
 const v=()=>preparedPortalPriceVersionInput('v',context);
 assert.deepEqual(v(),preparedPortalPriceVersionInput('v',{...context,effectiveMarginB:20,inviteUpdatedAt:'changed'}));
 assert.notDeepEqual(v(),preparedPortalPriceVersionInput('v',{...context,effectiveMarginA:11}));
 assert.notDeepEqual(v(),preparedPortalPriceVersionInput('v',{...context,customerId:'other'}));
 assert.equal(priceListVersionRpc({versionContract:'publication-v1'}),'get_prepared_price_list_export_version');
 assert.equal(priceListVersionRpc({}),'get_admin_price_list_export_version');
});


test('bulk legacy price writes advance each affected brand revision once and queue its prepared file',async()=>{
 const db=await fixture();try{
  await admit(db);
  const revision=async()=>(await db.query('select source_revision::text r from supplier_price_source_versions where organization_id=$1 and brand_id=$2',[org,brand])).rows[0]?.r;
  await db.query("insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,buy_price,currency,is_active)select md5(i::text)::uuid,$1,$2,$3,'P'||i,i,'EUR',true from generate_series(1,500)i",[org,supplier,brand]);
  assert.equal(await revision(),'1');
  await db.query('update supplier_prices set buy_price=buy_price+1 where organization_id=$1 and brand_id=$2',[org,brand]);
  assert.equal(await revision(),'2');
  await db.query('delete from supplier_prices where organization_id=$1 and brand_id=$2',[org,brand]);
  assert.equal(await revision(),'3');
  assert.equal((await db.query('select count(*) n from prepared_price_export_profiles where next_check_at<=now()')).rows[0].n,1);
 }finally{await db.close();}
});

test('session/default-card no-op updates never requeue profiles; actual pricing changes do and continuously dirty profiles share the queue',async()=>{
 const db=await fixture();try{
  await admit(db);await admit(db,'second-margin','v1',{...scope,marginPercent:.2});
  await db.query("insert into portal_invites(id,organization_id,status,access_can_view_orders)values($1,$2,'active',true)",[id(20),org]);
  await db.query("insert into customer_price_lists(id,organization_id,list_type,margin_percent,is_active)values($1,$2,'A',10,true)",[id(21),org]);
  await db.exec("update prepared_price_export_profiles set revision=0,next_check_at=now()+interval '15 minutes'");
  await db.query("update portal_invites set status='active',access_can_view_orders=true where id=$1",[id(20)]);
  await db.query("update customer_price_lists set margin_percent=10,is_active=true,updated_at=clock_timestamp() where id=$1",[id(21)]);
  assert.ok((await db.query('select revision::int r from prepared_price_export_profiles')).rows.every(x=>x.r===0));
  await db.query('update customer_price_lists set margin_percent=11 where id=$1',[id(21)]);
  assert.ok((await db.query('select revision::int r from prepared_price_export_profiles')).rows.every(x=>x.r===1));
  await db.exec("update app_export_jobs set status='finalized'");
  const first=(await db.query('select * from claim_prepared_price_profile()')).rows[0];
  await db.query('select finish_prepared_price_profile($1,$2,$3)',[first.id,first.lease_token,first.revision]);
  await db.query('update customer_price_lists set margin_percent=12 where id=$1',[id(21)]);
  const next=(await db.query('select * from claim_prepared_price_profile()')).rows[0];
  assert.notEqual(first.id,next.id,'already checked profiles cannot starve a never-checked profile');
 }finally{await db.close();}
});
