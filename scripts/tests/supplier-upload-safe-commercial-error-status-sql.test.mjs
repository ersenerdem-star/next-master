import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFoundationTestDb, seedFoundationTestScope } from './fixtures/price-engine-foundation-db.mjs';
import { createFullReplayDb } from './fixtures/price-engine-full-replay-db.mjs';

const foundation=await readFile(new URL('../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql',import.meta.url),'utf8');
const previous=await readFile(new URL('../../supabase/migrations/20261014144957_supplier_price_workflow_failure_visibility.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('../../supabase/migrations/20261014183349_supplier_upload_safe_commercial_error_status.sql',import.meta.url),'utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),supplier=id(3),brand=id(5),actor=id(7),authSession=id(8),release=id(9),session=id(10),request=id(11);
const codes=['SOURCE_UNSUPPORTED_STOCK_QTY','SOURCE_UNSUPPORTED_ORDER_MULTIPLE','SOURCE_UNSUPPORTED_VALID_TO'];
const sql='SELECT public.get_supplier_price_upload_status($1,$2,$3,$4,$5,$6) value';
async function admin(db,query,args=[]){await db.exec('RESET ROLE');return db.query(query,args);}
async function status(db,values){await db.exec("RESET ROLE;SET ROLE service_role;SELECT set_config('request.jwt.claim.role','service_role',false)");return(await db.query(sql,values)).rows[0].value;}
async function snapshot(db){return(await admin(db,`SELECT jsonb_build_object(
 'release',(SELECT to_jsonb(r) FROM public.supplier_price_releases r WHERE id=$1),
 'session',(SELECT to_jsonb(u) FROM public.supplier_price_upload_sessions u WHERE id=$2),
 'verification',(SELECT to_jsonb(v) FROM supplier_price_ingestion_internal.verification_requests v WHERE id=$3),
 'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]') FROM public.supplier_price_release_events e),
 'pointers',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM public.supplier_current_price_pointers p)) value`,[release,session,request])).rows[0].value;}
async function fixture(t){
 const db=await createFoundationTestDb();t.after(()=>db.close());await db.exec(foundation);await seedFoundationTestScope(db);await db.exec(previous);
 const token=(await db.query("SELECT floor(extract(epoch from now()))::bigint iat,floor(extract(epoch from now()+interval '1 hour'))::bigint exp")).rows[0];
 const values=[session,actor,org,authSession,token.iat,token.exp];
 await db.query(`INSERT INTO public.supplier_price_releases(id,organization_id,supplier_id,brand_id,source_file_path,source_file_sha256,created_by,source_verification_required,status,total_rows,processed_rows,current_cursor)
 VALUES($1,$2,$3,$4,'safe-error-source.csv',repeat('a',64),$5,true,'received',1,0,0)`,[release,org,supplier,brand,actor]);
 await db.query(`INSERT INTO public.supplier_price_upload_sessions(id,organization_id,release_id,idempotency_key,storage_object_path,file_name,content_type,total_bytes,uploaded_bytes,status,created_by,expires_at)
 VALUES($1,$2,$3,'safe-error-fixture','safe-error-source.csv','source.csv','text/csv',100,100,'uploaded',$4,now()+interval '1 day')`,[session,org,release,actor]);
 await db.query(`INSERT INTO supplier_price_ingestion_internal.verification_requests(id,session_id,release_id,organization_id,actor_id,accepted_auth_session_id,accepted_token_iat,status,last_error)
 VALUES($1,$2,$3,$4,$5,$6,$7,'failed',$8)`,[request,session,release,org,actor,authSession,token.iat,codes[0]]);
 return{db,values};
}

test('only fixed failed-verification errors supplement the existing response without data/history mutation',async t=>{
 const{db,values}=await fixture(t);
 const oldStatus=await status(db,values),before=await snapshot(db);
 await db.exec(migration);
 const result=await status(db,values);
 assert.equal(result.error_code,codes[0]);assert.deepEqual({...result,error_code:null},oldStatus);
 assert.deepEqual(await snapshot(db),before,'migration and status reads preserve verification/release/upload/events/pointer records');
 for(const code of codes){await admin(db,'UPDATE supplier_price_ingestion_internal.verification_requests SET last_error=$1 WHERE id=$2',[code,request]);assert.equal((await status(db,values)).error_code,code);}
 for(const raw of [null,'ATTEMPTS_EXHAUSTED','SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD:stock_qty:row=2',codes[0]+': cell=SECRET-SOURCE-VALUE','secret signed URL or SQL details']){
  await admin(db,'UPDATE supplier_price_ingestion_internal.verification_requests SET last_error=$1 WHERE id=$2',[raw,request]);
  const output=await status(db,values);assert.equal(output.error_code,null);assert.deepEqual({...output,error_code:null},oldStatus);
  assert.ok(!JSON.stringify(output).includes('SECRET-SOURCE-VALUE'));
 }
});

test('nonterminal verification never exposes a prior error and release-domain error retains precedence',async t=>{
 const{db,values}=await fixture(t);await db.exec(migration);
 for(const state of ['queued','verifying','verified']){
  await admin(db,'UPDATE supplier_price_ingestion_internal.verification_requests SET status=$1,last_error=$2 WHERE id=$3',[state,codes[0],request]);
  assert.equal((await status(db,values)).error_code,null);
 }
 await admin(db,"UPDATE supplier_price_ingestion_internal.verification_requests SET status='failed',last_error=$1 WHERE id=$2",[codes[1],request]);
 for(const domain of ['VALIDATION_REVIEW_REQUIRED','SUPPLIER_PROCESSING_INTERRUPTED','BRAND_IDENTITY_MISMATCH']){
  await admin(db,'UPDATE public.supplier_price_releases SET error_code=$1 WHERE id=$2',[domain,release]);
  assert.equal((await status(db,values)).error_code,domain);
 }
 await admin(db,'UPDATE public.supplier_price_releases SET error_code=null WHERE id=$1',[release]);
 assert.equal((await status(db,values)).error_code,codes[1]);
 await admin(db,'DELETE FROM supplier_price_ingestion_internal.verification_requests WHERE id=$1',[request]);
 const absent=await status(db,values);assert.equal(absent.error_code,null);assert.equal(absent.verification_status,'not_requested');
});

test('service-only execution and actual session/profile/owner/org checks remain enforced',async t=>{
 const{db,values}=await fixture(t);await db.exec(migration);
 const signature='public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint)';
 const privileges=(await admin(db,`SELECT has_function_privilege('anon',$1,'EXECUTE') anon,
 has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service,
 has_table_privilege('service_role','supplier_price_ingestion_internal.verification_requests','SELECT') private_read`,[signature])).rows[0];
 assert.deepEqual(privileges,{anon:false,authenticated:false,service:true,private_read:false});
 for(const role of ['anon','authenticated']){await db.exec(`RESET ROLE;SET ROLE ${role}`);await assert.rejects(db.query(sql,values),/permission denied/);}
 await db.exec("RESET ROLE;SET ROLE service_role;SELECT set_config('request.jwt.claim.role','authenticated',false)");await assert.rejects(db.query(sql,values),/UPLOAD_STATUS_DENIED/);
 for(const[index,value]of[[0,id(99)],[1,id(99)],[2,id(2)],[3,id(99)],[4,0],[4,values[5]+3600],[5,1]]){
  const changed=[...values];changed[index]=value;await assert.rejects(status(db,changed),/UPLOAD_STATUS_DENIED/);
 }
 for(const change of [
  "UPDATE public.profiles SET is_active=false",
  "UPDATE public.profiles SET is_active=true,role='customer'",
  "UPDATE public.profiles SET role='superadmin',session_revoked_at=clock_timestamp()",
  "UPDATE public.profiles SET session_revoked_at=null;UPDATE auth.sessions SET not_after=now()-interval '1 second'",
 ]){await db.exec('RESET ROLE');await db.exec(change);await assert.rejects(status(db,values),/UPLOAD_STATUS_DENIED/);}
});

test('safe error status compiles after immutable62 and all separately deployed forwards',async()=>{
 const db=await createFullReplayDb();try{
  const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));assert.equal(manifest.migration_order.length,62);
  for(const item of manifest.migration_order)await db.exec(await readFile(item.file,'utf8'));
  for(const file of ['20261014162139_supplier_admin_release_action_queue.sql','20261014165817_price_list_legacy_scope_compatibility.sql','20261014171235_master_price_mixed_supplier_scopes.sql','20261014175649_supplier_source_commercial_compatibility_guard.sql'])await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
  await db.exec(migration);
  assert.equal((await db.query("SELECT count(*) n FROM supplier_price_ingestion_internal.source_compatibility_receipts")).rows[0].n,0);
 }finally{await db.close();}
});
