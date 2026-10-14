// One reviewed continuation only: the first production attempt rolled back22.
// This is not an arbitrary position, journal chain, retry or foundation replay.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';

export const RESUME22_JOURNAL_SHA256='653937e2990ab69ededd2853ce64584f8ed0301c603f0b5521eca37af2b5376a';
export const RESUME22_MANIFEST_SHA256='724820e254f5e4c0d16e1584324f70e78c5bbea4334018cc6fe86fce2602c549';
export const RESUME22_SQL_SHA256='12df60531faf7da9c6e4db4fada69cb2ae4ee01e81ce50e200ffdd85486d71b3';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw Error('RESUME22_EVIDENCE_UNCONFIRMED');};
// Local scope discovery only. Select objects actually changed by1..21, not
// unrelated baseline application objects or minimal external Auth/Storage tables.
const localScopeSql=`SELECT
 (SELECT jsonb_agg(jsonb_build_object('name',c.oid::regclass::text,'state',jsonb_build_array(
   c.relrowsecurity,c.relforcerowsecurity,
   (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   (SELECT jsonb_agg(pg_get_constraintdef(k.oid,false) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
   (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),
   (SELECT jsonb_agg(pg_get_triggerdef(t.oid,false) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
   (SELECT jsonb_agg(jsonb_build_array(p.polname,p.polcmd,p.polpermissive,ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END FROM unnest(p.polroles) r),pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
   (SELECT jsonb_agg(jsonb_build_array(role,has_table_privilege(role,c.oid,'SELECT'),has_table_privilege(role,c.oid,'INSERT'),has_table_privilege(role,c.oid,'UPDATE'),has_table_privilege(role,c.oid,'DELETE')) ORDER BY role) FROM unnest(ARRAY['anon','authenticated','service_role']) role)
 )) ORDER BY c.oid::regclass::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','supplier_price_ingestion_internal','supplier_price_validation_internal')) tables,
 (SELECT jsonb_agg(jsonb_build_object('name',p.oid::regprocedure::text,'state',jsonb_build_array(md5(pg_get_functiondef(p.oid)),has_function_privilege('anon',p.oid,'EXECUTE'),has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('service_role',p.oid,'EXECUTE'))) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind='f' AND n.nspname IN ('public','supplier_price_ingestion_internal','supplier_price_validation_internal')) functions`;

export function validateResume22Evidence(bytes,expectedSha256,plan){
 if(expectedSha256!==RESUME22_JOURNAL_SHA256||hash(bytes)!==expectedSha256
  ||plan?.manifest_sha256!==RESUME22_MANIFEST_SHA256||plan.entries?.length!==62)fail();
 let rows;try{rows=bytes.toString('utf8').trim().split('\n').map(line=>JSON.parse(line));}catch{fail();}
 let cursor=0,lastTime=0;
 const next=expected=>{
  const row=rows[cursor++];if(!row||!Number.isFinite(Date.parse(row.at))||Date.parse(row.at)<lastTime)fail();
  lastTime=Date.parse(row.at);const {at:_at,...value}=row;
  if(!isDeepStrictEqual(value,expected))fail();
 };
 const target={project_ref:'zjgueqijumzlfioihnkt',host:'aws-0-eu-west-1.pooler.supabase.com',
  user:'postgres.zjgueqijumzlfioihnkt',database:'postgres',port:5432,tls_certificate_verification:true,transaction:false,pooling:'session'};
 next({event:'started',mode:'apply',target,manifest_sha256:plan.manifest_sha256,order_sha256:plan.order_sha256});
 next({event:'baseline-verified',ready:true});next({event:'indexes-verified',ready:true});
 const completed=[];
 for(const entry of plan.entries.slice(0,22)){
  if(entry.position===21)next({event:'indexes-verified',ready:true});
  next({event:'migration-start',position:entry.position,id:entry.id,file:entry.file,sha256:entry.sha256,
   body_sha256:entry.body_sha256,outer_wrapper_removed:entry.wrapped});
  if(entry.position===22){next({event:'migration-rolled-back',position:22});break;}
  next({event:'commit-requested',position:entry.position,sha256:entry.sha256});
  next({event:'migration-committed',position:entry.position,sha256:entry.sha256});
  completed.push({position:entry.position,id:entry.id,sha256:entry.sha256});
 }
 next({event:'finished',schema_version:1,project_ref:target.project_ref,mode:'apply',status:'failed',
  outcome:'failed-transaction-rolled-back',completed,migration_ddl_attempted:22,customer_alignment_attempted:false,
  manifest_sha256:plan.manifest_sha256,failure:{stage:'migration-body',position:22,code:'55P03'}});
 if(cursor!==rows.length)fail();
 return {from_position:22,journal_sha256:expectedSha256,target,previously_committed:completed};
}

export async function buildResume22Reconciliation(plan){
 if(plan?.manifest_sha256!==RESUME22_MANIFEST_SHA256)fail();
 const {createFullReplayDb}=await import('../tests/fixtures/price-engine-full-replay-db.mjs');
 const sql=await readFile(new URL('./price-engine-resume22-reconciliation.sql',import.meta.url),'utf8');
 if(hash(sql)!==RESUME22_SQL_SHA256)throw Error('RESUME22_RECONCILIATION_SQL_CHANGED');
 const db=await createFullReplayDb();
 try{
  // The captured default was unqualified. Production resolves this one column
  // to pg_catalog; the fixture's extensions-first creation path resolved it to
  // pgcrypto instead. Reconstruct the exact catalog identity, never ignore it.
  await db.exec('ALTER TABLE public.supplier_prices ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid()');
  // Reconstruct the captured postgres/public default function ACL before new
  // functions are created. Each migration's later REVOKE/GRANT still applies.
  await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated,service_role');
  for(const item of plan.indexPlan.operations)await db.exec(item.source_sql);
  await db.exec('SET search_path=pg_catalog');
  const before=(await db.query(localScopeSql)).rows[0];
  await db.exec('SET search_path=public,extensions,pg_catalog');
  for(const entry of plan.entries.slice(0,21)){
   await db.exec('BEGIN');await db.exec(entry.sql);await db.exec('COMMIT');
  }
  // Only the explicitly reviewed customer condition is tested. No production
  // business values are copied into this disposable schema fixture.
  await db.exec("INSERT INTO public.organizations(id,name) VALUES('1e4c5e99-e387-41aa-a6d3-cbe74558f766','Synthetic resume fixture'); INSERT INTO public.customers(id,organization_id,customer_number,price_list_type) VALUES('fd9f8834-7935-4050-8895-fde8a2eb4914','1e4c5e99-e387-41aa-a6d3-cbe74558f766','RESUME22','C')");
  await db.exec('SET search_path=pg_catalog');
  const after=(await db.query(localScopeSql)).rows[0];
  const changed=section=>after[section].filter(row=>!isDeepStrictEqual(row.state,
    before[section].find(previous=>previous.name===row.name)?.state)).map(row=>row.name);
  const tables=[...new Set([...changed('tables'),'public.supplier_prices'])].sort();
  const functions=[...new Set([...changed('functions'),'public.begin_supplier_price_import(text,text,text)',
    'public.bulk_import_supplier_prices(jsonb)'])].sort();
  const parameters=[tables,functions];
  const expected=(await db.query(sql,parameters)).rows[0]?.resume22_snapshot;
  if(!expected||expected.snapshot_version!==1||expected.scope_valid!==true||tables.length!==16||functions.length!==47
    ||!Object.values(expected.migration22_not_applied||{}).every(value=>value===true)
    ||!Object.values(expected.empty_new_workflow_state||{}).every(value=>value===true)
    ||expected.publication_controls_off!==true||expected.ersen_unchanged_c_null_margin!==true)
   throw Error('RESUME22_LOCAL_SNAPSHOT_INVALID');
  return {sql,sql_sha256:hash(sql),parameters,expected};
 }finally{await db.close();}
}

export function inspectResume22Snapshot(reconciliation,snapshot){
 return {ready:isDeepStrictEqual(snapshot,reconciliation.expected),
  expected_sha256:hash(JSON.stringify(reconciliation.expected)),
  actual_sha256:hash(JSON.stringify(snapshot??null))};
}
