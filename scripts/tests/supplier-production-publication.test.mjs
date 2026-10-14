import test,{beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {productionPublicationRequest,runProductionPublicationOperator,productionReversalRequest,runProductionReversalOperator}
  from '../../apps/engine/supplier-price-shadow/src/production-publication-operator.mjs';
import {SERVICE_RPC_NAMES} from '../../apps/engine/supplier-price-shadow/src/worker-service.mjs';

const migration='supabase/migrations/20261014110614_supplier_price_production_publication_decision.sql';
const db=new PGlite();
await db.exec(readFileSync('scripts/tests/supplier-production-publication-pg.setup.sql','utf8'));
await db.exec(readFileSync(migration,'utf8'));
const {rows:[initialControl]}=await db.query('select enabled,reversal_enabled from supplier_price_ingestion_internal.production_publication_control');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),supplier=id(2),brand=id(3),actor=id(4),release=id(10),second=id(11),decision=id(20);
const call=async(patch={})=>{
 const values={project:'zjgueqijumzlfioihnkt',release,org,supplier,brand,actor,decision,revision:0,previous:null,...patch};
 const {rows}=await db.query('select public.publish_supplier_price_release_production($1,$2,$3,$4,$5,$6,$7,$8,$9) as receipt',
  ['project','release','org','supplier','brand','actor','decision','revision','previous'].map(key=>values[key]));
 return rows[0].receipt;
};
const counts=async()=>{
 const {rows}=await db.query('select (select count(*)::integer from public.supplier_price_publications) publications,'+
  '(select count(*)::integer from supplier_price_ingestion_internal.production_publication_decisions) decisions,'+
  '(select count(*)::integer from public.supplier_price_release_events) events');
 return rows[0];
};
const reverse=async(patch={})=>{
 const fields={project:'zjgueqijumzlfioihnkt',org,supplier,brand,actor,decision:id(30),target:decision,current:null,revision:null,...patch};
 const {rows}=await db.query('select public.reverse_supplier_price_publication_production($1,$2,$3,$4,$5,$6,$7,$8,$9) as receipt',
  ['project','org','supplier','brand','actor','decision','target','current','revision'].map(key=>fields[key]));
 return rows[0].receipt;
};
beforeEach(async()=>{
 await db.exec("reset role; select set_config('request.jwt.claim.role','service_role',false);"+
  'truncate supplier_price_ingestion_internal.production_publication_reversals,supplier_price_ingestion_internal.production_publication_decisions,public.supplier_current_price_pointers,'+
  'public.supplier_price_release_events,public.supplier_price_publications,public.supplier_price_releases,public.profiles,public.fixture_current_identity cascade;'+
  "update supplier_price_ingestion_internal.production_publication_control set enabled=true,reversal_enabled=true,activation_decision_id='"+id(99)+"',activated_by='"+actor+"',activated_at=now();");
 await db.query('insert into profiles values($1,$2,\'admin\',true),($3,$2,\'superadmin\',true),($4,$2,\'admin\',false),($5,$2,\'sales\',true),($6,$7,\'admin\',true)',
  [actor,org,id(5),id(6),id(7),id(8),id(9)]);
 for(const value of [release,second]) {
  await db.query('insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,status,validated_at,total_rows,accepted_rows,processed_rows,current_cursor,rejected_rows,warning_rows,conflict_rows,source_verification_required,uploaded_at,source_file_path,source_file_sha256,review_revision,brand_identity_audit) '+
    "values($1,$2,$3,$4,'validated',now(),2,2,2,2,0,0,0,true,now(),'source.csv',$5,0,$6)",
    [value,org,supplier,brand,'a'.repeat(64),{policy:'cross-brand-v1',checked:true,review_required:false}]);
  await db.query('insert into fixture_current_identity(release_id,allowed) values($1,true)',[value]);
 }
});
after(async()=>db.close());

test('Migration seeds publication disabled and exposes neither private control nor ledger',async()=>{
 assert.deepEqual(initialControl,{enabled:false,reversal_enabled:false});
 await db.exec('update supplier_price_ingestion_internal.production_publication_control set enabled=false');
 await assert.rejects(call(),/PRODUCTION_PUBLICATION_NOT_ENABLED/);
 assert.deepEqual(await counts(),{publications:0,decisions:0,events:0});
 const {rows}=await db.query("select relname,relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='supplier_price_ingestion_internal' and c.relkind='r'");
 assert.equal(rows.every(row=>row.relrowsecurity),true);
 for(const role of ['anon','authenticated','service_role']) {
  const {rows:[priv]}=await db.query('select has_table_privilege($1,\'supplier_price_ingestion_internal.production_publication_control\',\'UPDATE\') control,'+
    'has_table_privilege($1,\'supplier_price_ingestion_internal.production_publication_decisions\',\'INSERT\') ledger',[role]);
  assert.equal(priv.control,false);assert.equal(priv.ledger,false);
 }
});

test('One reviewed publication persists actor, revision, previous pointer and current identity audit atomically',async()=>{
 const result=await call();assert.equal(result.replayed,false);assert.equal(result.is_current,true);
 assert.equal(result.actor_id,actor);assert.equal(result.review_revision,0);assert.equal(result.expected_previous_publication_id,null);
 const {rows:[saved]}=await db.query('select * from supplier_price_ingestion_internal.production_publication_decisions');
 assert.equal(saved.actor_id,actor);assert.equal(saved.decision_id,decision);assert.equal(saved.source_sha256,'a'.repeat(64));
 assert.equal(saved.identity_audit.checked,true);assert.equal(saved.publication_id,result.publication_id);
 assert.deepEqual(await counts(),{publications:1,decisions:1,events:1});
 const {rows:[fresh]}=await db.query('select calls from fixture_current_identity where release_id=$1',[release]);assert.equal(fresh.calls,1);
});

test('Exact decision replay has no writes; changed actor/scope/revision/previous binding cannot reuse an approval',async()=>{
 const first=await call();assert.deepEqual(await call(),{...first,replayed:true});
 for(const patch of [{actor:id(5)},{release:second},{revision:1},{previous:id(40)},{brand:id(30)}])
  await assert.rejects(call(patch),/PRODUCTION_PUBLICATION_DECISION_CONFLICT/);
 assert.deepEqual(await counts(),{publications:1,decisions:1,events:1});
});

test('Approved publication and reversal ledgers reject later DML edits or deletion',async()=>{
 const published=await call();
 await assert.rejects(db.query('update supplier_price_ingestion_internal.production_publication_decisions set actor_id=$1',[id(5)]),/IMMUTABLE_LEDGER/);
 await assert.rejects(db.exec('delete from supplier_price_ingestion_internal.production_publication_decisions'),/IMMUTABLE_LEDGER/);
 await reverse({current:published.publication_id});
 await assert.rejects(db.query('update supplier_price_ingestion_internal.production_publication_reversals set actor_id=$1',[id(5)]),/IMMUTABLE_LEDGER/);
 await assert.rejects(db.exec('delete from supplier_price_ingestion_internal.production_publication_reversals'),/IMMUTABLE_LEDGER/);
});

test('Expected previous pointer is compare-and-set; old decision replay cannot restore a superseded price list',async()=>{
 const first=await call();
 await assert.rejects(call({release:second,decision:id(21)}),/PRODUCTION_PUBLICATION_STALE_POINTER/);
 const next=await call({release:second,decision:id(21),previous:first.publication_id});
 assert.equal(next.version,2);assert.equal(next.is_current,true);
 const replay=await call();assert.equal(replay.replayed,true);assert.equal(replay.is_current,false);
 const {rows:[pointer]}=await db.query('select publication_id,release_id from supplier_current_price_pointers');
 assert.deepEqual(pointer,{publication_id:next.publication_id,release_id:second});
 assert.deepEqual(await counts(),{publications:2,decisions:2,events:2});
});

test('Current identity evidence can block a previously checked audit without moving a published pointer',async()=>{
 const first=await call();await db.query('update fixture_current_identity set allowed=false where release_id=$1',[second]);
 const held=await call({release:second,decision:id(21),previous:first.publication_id});
 assert.equal(held.status,'review_required');assert.equal(held.published,false);
 assert.deepEqual(await counts(),{publications:1,decisions:1,events:1});
 const {rows:[pointer]}=await db.query('select release_id from supplier_current_price_pointers');assert.equal(pointer.release_id,release);
 const {rows:[blocked]}=await db.query('select error_code,brand_identity_audit from supplier_price_releases where id=$1',[second]);
 assert.equal(blocked.error_code,'CROSS_BRAND_BULK_OVERLAP');assert.equal(blocked.brand_identity_audit.review_required,true);
});

test('A partial merge release cannot become either the first pointer or replace a complete published list',async()=>{
 await db.query("update supplier_price_releases set mode='merge' where id=$1",[release]);
 await assert.rejects(call(),/PRODUCTION_PUBLICATION_REPLACE_REQUIRED/);
 assert.deepEqual(await counts(),{publications:0,decisions:0,events:0});
 const {rows:[empty]}=await db.query('select count(*)::integer count from supplier_current_price_pointers');assert.equal(empty.count,0);
 await db.query("update supplier_price_releases set mode='replace' where id=$1",[release]);
 const first=await call();await db.query("update supplier_price_releases set mode='merge' where id=$1",[second]);
 await assert.rejects(call({release:second,decision:id(21),previous:first.publication_id}),/PRODUCTION_PUBLICATION_REPLACE_REQUIRED/);
 assert.deepEqual(await counts(),{publications:1,decisions:1,events:1});
 const {rows:[pointer]}=await db.query('select publication_id,release_id from supplier_current_price_pointers');
 assert.deepEqual(pointer,{publication_id:first.publication_id,release_id:release});
});

test('Only active tenant administrators may attribute a production publication',async()=>{
 for(const wrongActor of [id(6),id(7),id(8),id(88)])await assert.rejects(call({actor:wrongActor}),/PRODUCTION_PUBLICATION_ACTOR_INVALID/);
 assert.equal((await call({actor:id(5)})).actor_id,id(5));
});

test('Tenant scope and review revision fail closed before publication',async()=>{
 await assert.rejects(call({org:id(9)}),/PRODUCTION_PUBLICATION_ACTOR_INVALID/);
 for(const patch of [{supplier:id(77)},{brand:id(77)},{release:id(77)}])await assert.rejects(call(patch),/PRODUCTION_PUBLICATION_SCOPE_MISMATCH/);
 await assert.rejects(call({revision:1}),/PRODUCTION_PUBLICATION_STALE_REVIEW/);
 await assert.rejects(call({project:'kaxsqafdevabkxofwdod'}),/PRODUCTION_PUBLICATION_NOT_ENABLED/);
 assert.deepEqual(await counts(),{publications:0,decisions:0,events:0});
});

test('Incomplete, conflicted or unverified validation cannot publish',async()=>{
 for(const [column,value] of [['rejected_rows',1],['warning_rows',1],['conflict_rows',1],['accepted_rows',1],
  ['processed_rows',1],['current_cursor',1],['source_verification_required',false],['source_file_sha256','bad'],['source_file_path',null]]) {
  const {rows:[old]}=await db.query('select '+column+' as value from supplier_price_releases where id=$1',[release]);
  await db.query('update supplier_price_releases set '+column+'=$1 where id=$2',[value,release]);
  await assert.rejects(call(),/PRODUCTION_PUBLICATION_VALIDATION_NOT_CLEAR/);
  await db.query('update supplier_price_releases set '+column+'=$1 where id=$2',[old.value,release]);
 }
 await db.query("update supplier_price_releases set status='staged' where id=$1",[release]);
 await assert.rejects(call(),/PRODUCTION_PUBLICATION_RELEASE_NOT_VALIDATED/);
 assert.deepEqual(await counts(),{publications:0,decisions:0,events:0});
});

test('A corrupted current pointer cannot be silently superseded',async()=>{
 const first=await call();await db.query("update supplier_price_publications set status='superseded' where id=$1",[first.publication_id]);
 await assert.rejects(call({release:second,decision:id(21),previous:first.publication_id}),/PRODUCTION_PUBLICATION_CURRENT_POINTER_INVALID/);
 assert.deepEqual(await counts(),{publications:1,decisions:1,events:1});
});

test('Actual SQL roles cannot invoke publication or enable control through browser grants',async()=>{
 for(const role of ['anon','authenticated']) {
  await db.exec('set role '+role);
  await assert.rejects(call(),/permission denied/);await db.exec('reset role');
 }
 await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
 await assert.rejects(call(),/PRODUCTION_PUBLICATION_SERVICE_REQUIRED/);
 await db.exec("select set_config('request.jwt.claim.role','service_role',false); set role service_role");
 assert.equal((await call()).published,true);await db.exec('reset role');
});

test('Repeatable-read callers are refused rather than publishing against an old snapshot',async()=>{
 await db.exec('begin isolation level repeatable read');
 try{await assert.rejects(call(),/PRODUCTION_PUBLICATION_REQUIRES_READ_COMMITTED/);}finally{await db.exec('rollback');}
});

test('First publication rollback removes only its current pointer and records an archived release',async()=>{
 const published=await call();
 const result=await reverse({current:published.publication_id});
 assert.equal(result.reversed,true);assert.equal(result.restored_publication_id,null);assert.equal(result.is_restored_current,true);
 const {rows:[state]}=await db.query('select r.status release_status,p.status publication_status,'+
  '(select count(*)::integer from supplier_current_price_pointers) pointers from supplier_price_releases r '+
  'join supplier_price_publications p on p.release_id=r.id where r.id=$1',[release]);
 assert.deepEqual(state,{release_status:'archived',publication_status:'rolled_back',pointers:0});
 const {rows:[ledger]}=await db.query('select actor_id,target_decision_id,expected_current_publication_id from supplier_price_ingestion_internal.production_publication_reversals');
 assert.deepEqual(ledger,{actor_id:actor,target_decision_id:decision,expected_current_publication_id:published.publication_id});
 assert.deepEqual(await reverse({current:published.publication_id}),{...result,replayed:true});
});

test('Rollback restores the immediately previous scoped publication and preserves newer-pointer safety',async()=>{
 const first=await call();const next=await call({release:second,decision:id(21),previous:first.publication_id});
 const reversed=await reverse({target:id(21),current:next.publication_id,revision:0});
 assert.equal(reversed.restored_publication_id,first.publication_id);assert.equal(reversed.restored_release_id,release);
 const {rows:[pointer]}=await db.query('select publication_id,release_id from supplier_current_price_pointers');
 assert.deepEqual(pointer,{publication_id:first.publication_id,release_id:release});
 const {rows:[statuses]}=await db.query("select (select status from supplier_price_releases where id=$1) restored,"+
  "(select status from supplier_price_releases where id=$2) reversed",[release,second]);
 assert.deepEqual(statuses,{restored:'published',reversed:'superseded'});
 await assert.rejects(reverse({target:id(21),current:next.publication_id,decision:id(31),revision:0}),/PRODUCTION_REVERSAL_ALREADY_RECORDED/);
 await assert.rejects(reverse({target:id(21),current:next.publication_id,revision:1}),/PRODUCTION_REVERSAL_DECISION_CONFLICT/);
});

test('Reversal of an older decision cannot roll back a newer pointer',async()=>{
 const first=await call();const next=await call({release:second,decision:id(21),previous:first.publication_id});
 await assert.rejects(reverse({current:first.publication_id}),/PRODUCTION_REVERSAL_STALE_POINTER/);
 const {rows:[pointer]}=await db.query('select publication_id from supplier_current_price_pointers');assert.equal(pointer.publication_id,next.publication_id);
});

test('Reversal replay never moves a pointer created after its original rollback',async()=>{
 const first=await call();const reversed=await reverse({current:first.publication_id});
 const next=await call({release:second,decision:id(21)});
 const replay=await reverse({current:first.publication_id});assert.equal(replay.replayed,true);assert.equal(replay.is_restored_current,false);
 assert.equal(replay.restored_publication_id,reversed.restored_publication_id);
 const {rows:[pointer]}=await db.query('select publication_id from supplier_current_price_pointers');assert.equal(pointer.publication_id,next.publication_id);
});

test('Reversal remains independently gated and refuses inactive, cross-tenant or conflicting restore evidence',async()=>{
 const first=await call();const next=await call({release:second,decision:id(21),previous:first.publication_id});
 await db.exec('update supplier_price_ingestion_internal.production_publication_control set reversal_enabled=false');
 await assert.rejects(reverse({target:id(21),current:next.publication_id,revision:0}),/PRODUCTION_REVERSAL_NOT_ENABLED/);
 await db.exec('update supplier_price_ingestion_internal.production_publication_control set reversal_enabled=true,enabled=false');
 for(const patch of [{actor:id(6)},{actor:id(8)},{org:id(9)}])
  await assert.rejects(reverse({target:id(21),current:next.publication_id,revision:0,...patch}),/PRODUCTION_REVERSAL_ACTOR_INVALID/);
 await assert.rejects(reverse({target:id(21),current:next.publication_id,revision:1}),/PRODUCTION_REVERSAL_STALE_REVIEW/);
 await db.query('update fixture_current_identity set allowed=false where release_id=$1',[release]);
 const held=await reverse({target:id(21),current:next.publication_id,revision:0});assert.equal(held.reversed,false);
 const {rows:[pointer]}=await db.query('select publication_id from supplier_current_price_pointers');assert.equal(pointer.publication_id,next.publication_id);
});

test('Rollback refuses a previous merge snapshot and leaves the complete current pointer unchanged',async()=>{
 const first=await call();const next=await call({release:second,decision:id(21),previous:first.publication_id});
 await db.query("update supplier_price_releases set mode='merge' where id=$1",[release]);
 await assert.rejects(reverse({target:id(21),current:next.publication_id,revision:0}),/PRODUCTION_REVERSAL_PREVIOUS_REPLACE_REQUIRED/);
 const {rows:[pointer]}=await db.query('select publication_id,release_id from supplier_current_price_pointers');
 assert.deepEqual(pointer,{publication_id:next.publication_id,release_id:second});
 const {rows:[ledger]}=await db.query('select count(*)::integer count from supplier_price_ingestion_internal.production_publication_reversals');
 assert.equal(ledger.count,0);assert.deepEqual(await counts(),{publications:2,decisions:2,events:2});
});

const env={SUPABASE_URL:'https://zjgueqijumzlfioihnkt.supabase.co',SUPPLIER_PRICE_EXPECTED_HOST:'zjgueqijumzlfioihnkt.supabase.co',
 SUPPLIER_PRICE_TARGET_ENVIRONMENT:'production',SUPPLIER_PRICE_PRODUCTION_ENABLED:'1',SUPPLIER_PRICE_PRODUCTION_PUBLICATION_ENABLED:'1',
 SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_only',SUPPLIER_PRICE_PUBLICATION_RELEASE_ID:release, // synthetic placeholder
 SUPPLIER_PRICE_PUBLICATION_ORGANIZATION_ID:org,SUPPLIER_PRICE_PUBLICATION_SUPPLIER_ID:supplier,SUPPLIER_PRICE_PUBLICATION_BRAND_ID:brand,
 SUPPLIER_PRICE_PUBLICATION_ACTOR_ID:actor,SUPPLIER_PRICE_PUBLICATION_DECISION_ID:decision,
 SUPPLIER_PRICE_PUBLICATION_REVIEW_REVISION:'0',SUPPLIER_PRICE_PUBLICATION_EXPECTED_PREVIOUS_ID:'none'};
test('Operator request requires explicit command, independent publication activation and reviewed CAS inputs',()=>{
 const request=productionPublicationRequest(env,'--publish-reviewed');assert.equal(request.body.input_expected_previous_publication_id,null);
 for(const [patch,argument] of [[{},undefined],[{},'--service'],[{SUPPLIER_PRICE_PRODUCTION_PUBLICATION_ENABLED:undefined},'--publish-reviewed'],
  [{SUPPLIER_PRICE_PUBLICATION_EXPECTED_PREVIOUS_ID:undefined},'--publish-reviewed'],[{SUPPLIER_PRICE_PUBLICATION_REVIEW_REVISION:undefined},'--publish-reviewed'],
  [{SUPPLIER_PRICE_PUBLICATION_ACTOR_ID:'invalid'},'--publish-reviewed'],[{SUPABASE_URL:'https://kaxsqafdevabkxofwdod.supabase.co'},'--publish-reviewed']])
  assert.throws(()=>productionPublicationRequest({...env,...patch},argument));
 assert.equal(SERVICE_RPC_NAMES.has('publish_supplier_price_release_production'),false);
 assert.doesNotMatch(readFileSync('apps/engine/supplier-price-shadow/src/worker.mjs','utf8'),/production-publication-operator/);
});

test('Trusted operator calls only the production RPC and returns a bounded audit receipt',async()=>{
 const result=await runProductionPublicationOperator({env,argument:'--publish-reviewed',fetchImpl:async(url,options)=>{
  assert.equal(url,env.SUPABASE_URL+'/rest/v1/rpc/publish_supplier_price_release_production');assert.equal(options.redirect,'error');
  assert.equal(options.headers.apikey,env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(options.headers.Authorization,undefined);
  const params=JSON.parse(options.body);
  const receipt=await call({revision:params.input_expected_review_revision,previous:params.input_expected_previous_publication_id});
  return {ok:true,json:async()=>({...receipt,unexpectedSecret:'never emit this'})};
 }});
 assert.equal(result.published,true);assert.equal(result.unexpectedSecret,undefined);
 for(const receipt of [{published:true,status:'published'},{published:false,status:'review_required'}])
  await assert.rejects(runProductionPublicationOperator({env,argument:'--publish-reviewed',
   fetchImpl:async()=>({ok:true,json:async()=>receipt})}),/PUBLICATION_/);
});

test('Operator reversal uses a separate opt-in, reviewed target and current pointer; worker has no reversal RPC',async()=>{
 const publication=await call();
 const reversalEnv={...env,SUPPLIER_PRICE_PRODUCTION_PUBLICATION_ENABLED:'0',SUPPLIER_PRICE_PRODUCTION_REVERSAL_ENABLED:'1',
  SUPPLIER_PRICE_REVERSAL_ORGANIZATION_ID:org,SUPPLIER_PRICE_REVERSAL_SUPPLIER_ID:supplier,SUPPLIER_PRICE_REVERSAL_BRAND_ID:brand,
  SUPPLIER_PRICE_REVERSAL_ACTOR_ID:actor,SUPPLIER_PRICE_REVERSAL_DECISION_ID:id(30),SUPPLIER_PRICE_REVERSAL_TARGET_DECISION_ID:decision,
  SUPPLIER_PRICE_REVERSAL_EXPECTED_CURRENT_ID:publication.publication_id,SUPPLIER_PRICE_REVERSAL_RESTORE_REVIEW_REVISION:'none'};
 assert.equal(productionReversalRequest(reversalEnv,'--reverse-reviewed').body.input_expected_restored_review_revision,null);
 assert.throws(()=>productionReversalRequest({...reversalEnv,SUPPLIER_PRICE_PRODUCTION_REVERSAL_ENABLED:undefined},'--reverse-reviewed'));
 assert.throws(()=>productionReversalRequest({...reversalEnv,SUPPLIER_PRICE_REVERSAL_EXPECTED_CURRENT_ID:undefined},'--reverse-reviewed'));
 assert.equal(SERVICE_RPC_NAMES.has('reverse_supplier_price_publication_production'),false);
 const result=await runProductionReversalOperator({env:reversalEnv,argument:'--reverse-reviewed',fetchImpl:async(url,options)=>{
  assert.equal(url,env.SUPABASE_URL+'/rest/v1/rpc/reverse_supplier_price_publication_production');assert.equal(options.redirect,'error');
  return {ok:true,json:async()=>({...await reverse({current:publication.publication_id}),privateValue:'never emit'})};
 }});
 assert.equal(result.reversed,true);assert.equal(result.published,false);assert.equal(result.privateValue,undefined);
});
