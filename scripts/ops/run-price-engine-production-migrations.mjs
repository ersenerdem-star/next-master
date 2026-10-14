#!/usr/bin/env node
// Deliberately narrow production runner. Import/default plan never connects.
// No environment fallback, subprocess arguments, automatic retries or resume.
import {createHash,X509Certificate} from 'node:crypto';
import {constants} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {assertConnectionTarget,buildPlan as buildIndexPlan,inspectIndexSnapshot,PRODUCTION_PROJECT}
 from './price-engine-production-index-prebuild.mjs';
import {inspectSnapshot} from './price-engine-production-preflight.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const MANIFEST='scripts/ops/price-engine-production-manifest.json';
const PREFLIGHT='scripts/ops/price-engine-production-preflight.sql';
const ALIGNMENT='scripts/ops/price-engine-production-customer-alignment.sql';
export const REVIEWED_ORDER_SHA256='866b2fd0af3fe7f287da75c8b55c1dddcecb7cbc76f8aa001f2fb0e3e5c873a0';
const PREFLIGHT_SHA256='fd6f5a001cb8a23dc06d9d651a8de6011dcaef1faeb596b68f233f6ed19fdcf0';
const ALIGNMENT_SHA256='806b1cb386ec925e0915fa2dc59c973fd7e5b788096ba16feb71baf00520ee98';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const IDENTITY_SQL="SELECT current_database()='postgres' AS database_ok, session_user='postgres' AS role_ok, current_user=session_user AS unassumed_role, pg_backend_pid() AS backend_pid, current_setting('server_version_num') AS server_version_num";
export const EXCLUSIVE_RUN_SQL='SELECT pg_try_advisory_lock(20261014,600029) AS acquired';
export const TRANSACTION_SETUP_SQL=[
 "SET LOCAL search_path = public, extensions, pg_catalog", "SET LOCAL lock_timeout = '1s'",
 "SET LOCAL statement_timeout = '30s'", "SET LOCAL transaction_timeout = '45s'",
 "SET LOCAL idle_in_transaction_session_timeout = '10s'",
];
const PUBLIC_CODES=new Set(['23505','23514','25001','25P02','40P01','42501','42P01','42703','42710',
 '55P03','57014','08001','08003','08004','08006','28P01','28000','53300','53400','57P01','57P02','57P03',
 '53200','53100','XX000','ENOTFOUND','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOENT','EACCES',
 'EPERM','ELOOP','EEXIST','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN',
 'DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
class GuardError extends Error{constructor(code){super(code);this.safeCode=code;}}
export const safeMigrationFailure=error=>({code:error instanceof GuardError?error.safeCode:
 PUBLIC_CODES.has(error?.code)?error.code:'UNCLASSIFIED_FAILURE'});
const fail=code=>{throw new GuardError(code);};

// Only locate top-level transaction boundaries. Function/DO bodies and quoted
// text cannot introduce boundaries; migration content remains hash-pinned.
export function migrationBody(sql){
 const statements=[];let tokens=[],offset=0;
 while(offset<sql.length){
  const start=offset;
  if(/\s/.test(sql[offset])){offset++;continue;}
  if(sql.startsWith('--',offset)){const end=sql.indexOf('\n',offset+2);offset=end<0?sql.length:end+1;continue;}
  if(sql.startsWith('/*',offset)){
   offset+=2;let depth=1;
   while(offset<sql.length&&depth){
    if(sql.startsWith('/*',offset)){depth++;offset+=2;}
    else if(sql.startsWith('*/',offset)){depth--;offset+=2;}else offset++;
   }
   if(depth)fail('MIGRATION_SQL_UNTERMINATED');continue;
  }
  const dollar=sql.slice(offset).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/i)?.[0];
  if(dollar){const end=sql.indexOf(dollar,offset+dollar.length);if(end<0)fail('MIGRATION_SQL_UNTERMINATED');offset=end+dollar.length;}
  else if(sql[offset]==="'"||sql[offset]==='"'){
   const quote=sql[offset++],escaped=quote==="'"&&/^e$/i.test(tokens.at(-1)?.raw||'')&&tokens.at(-1)?.end===start;
   let closed=false;
   while(offset<sql.length){
    if(escaped&&sql[offset]==='\\'){offset+=2;continue;}
    if(sql[offset++]===quote){if(sql[offset]===quote)offset++;else{closed=true;break;}}
   }
   if(!closed)fail('MIGRATION_SQL_UNTERMINATED');
  }else if(/[a-z_0-9]/i.test(sql[offset])){while(offset<sql.length&&/[a-z_0-9$]/i.test(sql[offset]))offset++;}
  else offset++;
  const raw=sql.slice(start,offset);tokens.push({raw,lower:raw.toLowerCase(),start,end:offset});
  if(raw===';'){statements.push(tokens);tokens=[];}
 }
 if(tokens.length)statements.push(tokens);
 const words=statement=>statement.filter(token=>token.raw!==';').map(token=>token.lower);
 let body=sql,wrapped=false,inner=statements;
 if(words(statements[0]||[]).join(' ')==='begin'){
  if(words(statements.at(-1)||[]).join(' ')!=='commit')fail('MIGRATION_TRANSACTION_BOUNDARY_INVALID');
  body=sql.slice(statements[0].at(-1).end,statements.at(-1)[0].start);
  inner=statements.slice(1,-1);wrapped=true;
 }
 for(const statement of inner){
  const first=words(statement)[0];
  if(['begin','start','commit','end','rollback','savepoint','release','prepare'].includes(first))
   fail('MIGRATION_TRANSACTION_CONTROL_FORBIDDEN');
 }
 if(!inner.length)fail('MIGRATION_BODY_EMPTY');
 return {sql:body,wrapped,body_sha256:hash(body)};
}

export async function buildMigrationPlan({manifestBytes,expectedManifestSha256,
 loadFile=file=>readFile(resolve(root,file)),indexPlanFactory=buildIndexPlan}={}){
 const bytes=manifestBytes||await loadFile(MANIFEST);
 if(!/^[a-f0-9]{64}$/.test(expectedManifestSha256||'')||hash(bytes)!==expectedManifestSha256)fail('MANIFEST_HASH_UNCONFIRMED');
 let manifest;try{manifest=JSON.parse(bytes);}catch{fail('MANIFEST_INVALID');}
 if(manifest?.schema_version!==1||manifest.environment!=='production-preparation'
  ||manifest.targets?.production_project_ref!==PRODUCTION_PROJECT||manifest.migration_order?.length!==62)
  fail('MANIFEST_TARGET_OR_COUNT_INVALID');
 const order=manifest.migration_order.map(({id,file,sha256})=>({id,file,sha256}));
 if(hash(JSON.stringify(order))!==REVIEWED_ORDER_SHA256)fail('REVIEWED_MIGRATION_ORDER_CHANGED');
 const entries=[];
 for(const [index,entry] of order.entries()){
  const source=await loadFile(entry.file);if(hash(source)!==entry.sha256)fail('MIGRATION_HASH_CHANGED');
  const body=migrationBody(source.toString('utf8'));
  if(body.wrapped!==[0,48].includes(index))fail('MIGRATION_WRAPPER_CHANGED');
  entries.push({...entry,position:index+1,...body});
 }
 const alignment=manifest.controlled_data_operations?.find(item=>item.id==='ersen-profile-c-to-a');
 if(alignment?.file!==ALIGNMENT||alignment.sha256!==ALIGNMENT_SHA256||alignment.expected_target!==PRODUCTION_PROJECT)
  fail('CUSTOMER_ALIGNMENT_UNCONFIRMED');
 const alignmentBytes=await loadFile(ALIGNMENT),preflightBytes=await loadFile(PREFLIGHT);
 if(hash(alignmentBytes)!==ALIGNMENT_SHA256||hash(preflightBytes)!==PREFLIGHT_SHA256)fail('REVIEWED_SUPPORT_SQL_CHANGED');
 const indexPlan=await indexPlanFactory({bytes});
 if(indexPlan.manifest_sha256!==expectedManifestSha256)fail('INDEX_PLAN_MANIFEST_CHANGED');
 return {schema_version:1,project_ref:PRODUCTION_PROJECT,manifest_sha256:expectedManifestSha256,
  order_sha256:REVIEWED_ORDER_SHA256,entries,indexPlan,preflight_sql:preflightBytes.toString(),
  alignment_sql:alignmentBytes.toString(),alignment_sha256:ALIGNMENT_SHA256,alignment_before_position:29};
}

const defaultClient=async config=>new (await import('pg')).default.Client(config);
export async function runProductionMigrations({plan,connection,apply=false,alignErsen=false,record},
 {regeneratePlan=()=>buildMigrationPlan({expectedManifestSha256:plan?.manifest_sha256}),createClient=defaultClient}={}){
 const evidence={schema_version:1,project_ref:PRODUCTION_PROJECT,mode:apply?'apply':'inspect',status:'failed',
  outcome:'not-started',completed:[],migration_ddl_attempted:0,customer_alignment_attempted:false};
 let client,asyncError,backendPid,transactionOpen=false,commitSent=false,position=null,stage='plan-validation';
 const emit=event=>record({at:new Date().toISOString(),...event});
 const query=async(sql,parameters)=>{
  if(asyncError)throw asyncError;
  const result=await client.query(sql,parameters);
  if(asyncError)throw asyncError;
  return result;
 };
 try{
  if(typeof apply!=='boolean'||typeof alignErsen!=='boolean'||typeof record!=='function'||apply&&!alignErsen)
   fail('RUNNER_ARGUMENT_INVALID');
  if(!isDeepStrictEqual(plan,await regeneratePlan()))fail('REVIEWED_PLAN_DRIFT');
  evidence.manifest_sha256=plan.manifest_sha256;
  stage='connection-validation';let target;
  try{target=assertConnectionTarget(connection);}catch{fail('CONNECTION_TARGET_UNCONFIRMED');}
  if(typeof connection.password!=='string'||!connection.password||/[\r\n\0]/.test(connection.password))fail('PASSWORD_FILE_INVALID');
  await emit({event:'started',mode:evidence.mode,target,manifest_sha256:plan.manifest_sha256,order_sha256:plan.order_sha256});
  client=await createClient({host:target.host,user:target.user,database:'postgres',port:5432,password:connection.password,
   ssl:{ca:connection.ssl.ca,rejectUnauthorized:true},options:'',application_name:'nm-price-migrations-20261014',
   connectionTimeoutMillis:10000,query_timeout:46000,keepAlive:true});
  client.on('error',error=>{asyncError=error;});stage='connect';await client.connect();
  if(asyncError)throw asyncError;
  if(client.connection?.stream?.encrypted!==true||client.connection.stream.authorized!==true)fail('TLS_SESSION_UNVERIFIED');
  const identity=async()=>{
   const row=(await query(IDENTITY_SQL)).rows?.[0];
   if(row?.database_ok!==true||row.role_ok!==true||row.unassumed_role!==true||Math.floor(Number(row.server_version_num)/10000)!==17
    ||!Number.isSafeInteger(row.backend_pid)||row.backend_pid<1||backendPid&&backendPid!==row.backend_pid)
    fail('DEDICATED_PG17_SESSION_UNCONFIRMED');
   backendPid=row.backend_pid;
  };
  stage='session-setup';
  for(const sql of plan.indexPlan.session_setup_sql)await query(sql);
  await query("SET application_name = 'nm-price-migrations-20261014'");
  await query("SET statement_timeout = '30s'");
  await identity();
  if(!apply)await query('SET default_transaction_read_only = on');
  stage='baseline-verification';
  const baseline=(await query(plan.preflight_sql)).rows?.[0]?.price_engine_preflight;
  const baselineCheck=inspectSnapshot({project_ref:PRODUCTION_PROJECT,data:baseline},{phase:'baseline',expectedProject:PRODUCTION_PROJECT});
  await emit({event:'baseline-verified',ready:baselineCheck.ready});
  if(!baselineCheck.ready)fail('PRODUCTION_BASELINE_UNCONFIRMED');
  const indexes=async()=>{
   // The shared index validator also verifies its exact session settings.
   await query("SET statement_timeout = '30min'");
   let check;
   try{
    const data=(await query(plan.indexPlan.verification_sql)).rows?.[0]?.index_prebuild_snapshot;
    check=inspectIndexSnapshot(plan.indexPlan,{project_ref:PRODUCTION_PROJECT,data},{phase:'after'});
   }finally{await query("SET statement_timeout = '30s'");}
   await emit({event:'indexes-verified',ready:check.ready});
   if(!check.ready)fail('PREBUILT_INDEXES_UNCONFIRMED');
  };
  stage='index-verification';await indexes();
  if(!apply){evidence.status='inspected';evidence.outcome='read-only';}
  else{
   stage='exclusive-run';
   if((await query(EXCLUSIVE_RUN_SQL)).rows?.[0]?.acquired!==true)fail('ANOTHER_MIGRATION_RUN_ACTIVE');
   for(const entry of plan.entries){
    position=entry.position;stage='before-migration';await identity();
    // Recheck immediately before migrations containing an ordinary existing-
    // table index, so missing/invalid indexes never silently build in this path.
    if(plan.indexPlan.operations.some(item=>item.source.file===entry.file||item.repeated_in.some(repeat=>repeat.file===entry.file)||item.superseded_in?.some(repeat=>repeat.file===entry.file)))await indexes();
    await emit({event:'migration-start',position,id:entry.id,file:entry.file,sha256:entry.sha256,
     body_sha256:entry.body_sha256,outer_wrapper_removed:entry.wrapped});
    stage='begin';await query('BEGIN');transactionOpen=true;
    for(const sql of TRANSACTION_SETUP_SQL)await query(sql);
    if(position===29){
     stage='customer-alignment';await emit({event:'customer-alignment-start',position,sha256:plan.alignment_sha256});
     evidence.customer_alignment_attempted=true;await query(plan.alignment_sql);
    }
    stage='migration-body';evidence.migration_ddl_attempted++;await query(entry.sql);
    stage='commit-journal';await emit({event:'commit-requested',position,sha256:entry.sha256});
    stage='commit';commitSent=true;
    const result=await query('COMMIT');
    if(result?.command!=='COMMIT')fail('COMMIT_ACK_UNCONFIRMED');
    transactionOpen=false;stage='commit-receipt';
    await emit({event:'migration-committed',position,sha256:entry.sha256});
    evidence.completed.push({position,id:entry.id,sha256:entry.sha256});commitSent=false;
   }
   evidence.status='completed';evidence.outcome='all-62-committed';
  }
 }catch(error){
  evidence.failure={stage,position,...safeMigrationFailure(error)};
  if(commitSent)evidence.outcome='unknown-requires-read-only-reconciliation';
  else if(transactionOpen){
   try{
    const result=await query('ROLLBACK');
    if(result?.command!=='ROLLBACK')fail('ROLLBACK_ACK_UNCONFIRMED');
    transactionOpen=false;evidence.outcome='failed-transaction-rolled-back';
    await emit({event:'migration-rolled-back',position});
   }catch{evidence.outcome='unknown-requires-read-only-reconciliation';}
  }else evidence.outcome=evidence.completed.length?'stopped-after-confirmed-commits':'no-migration-started';
 }finally{
  // No reconnect/cancel/retry and no assumption that closing resolves an
  // ambiguous commit. The session lock is released by closing the connection.
  if(client)try{await client.end();}catch{evidence.connection_close_unconfirmed=true;}
 }
 try{await emit({event:'finished',...evidence});}
 catch{
  evidence.status='failed';evidence.journal_write_failed=true;
  if(commitSent)evidence.outcome='unknown-requires-read-only-reconciliation';
 }
 return evidence;
}

export function parseMigrationArgs(args){
 const options={mode:'plan'},seen=new Set();
 for(let i=0;i<args.length;i++){
  const key=args[i];if(seen.has(key))fail('RUNNER_ARGUMENT_INVALID');seen.add(key);
  if(['--plan','--inspect','--apply'].includes(key)){options.mode=key.slice(2);continue;}
  if(key==='--align-ersen-before-29'){options.alignErsen=true;continue;}
  if(!['--project-ref','--manifest-sha256','--host','--password-file','--ca-file','--evidence'].includes(key)
   ||!args[i+1]||args[i+1].startsWith('--'))fail('RUNNER_ARGUMENT_INVALID');
  options[key.slice(2)]=args[++i];
 }
 if(['--plan','--inspect','--apply'].filter(key=>seen.has(key)).length>1)fail('RUNNER_ARGUMENT_INVALID');
 if(options['project-ref']!==PRODUCTION_PROJECT||!/^[a-f0-9]{64}$/.test(options['manifest-sha256']||''))fail('RUNNER_ARGUMENT_INVALID');
 if(options.mode!=='plan'&&['host','password-file','ca-file','evidence'].some(key=>!options[key]))fail('RUNNER_ARGUMENT_INVALID');
 if(options.mode==='apply'&&!options.alignErsen||options.mode!=='apply'&&options.alignErsen)fail('RUNNER_ARGUMENT_INVALID');
 if(options.mode==='plan'&&['host','password-file','ca-file','evidence'].some(key=>options[key]))fail('RUNNER_ARGUMENT_INVALID');
 return options;
}
export async function readMigrationPassword(path){
 const file=await open(resolve(path),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();
  if(!info.isFile()||(info.mode&0o077)!==0||process.getuid&&info.uid!==process.getuid()||info.size<1||info.size>4096)
   fail('PASSWORD_FILE_PERMISSIONS_OR_SIZE_INVALID');
  const password=(await file.readFile('utf8')).replace(/\r?\n$/,'');
  if(!password||/[\r\n\0]/.test(password))fail('PASSWORD_FILE_INVALID');return password;
 }finally{await file.close();}
}
async function main(args){
 if(!args.length||args.includes('--help')){
  console.log('Offline plan by default; no automatic retry/resume. Production migration execution is a separate explicit action.\n'+
   'node scripts/ops/run-price-engine-production-migrations.mjs --project-ref zjgueqijumzlfioihnkt --manifest-sha256 <reviewed exact manifest SHA256> [--plan]\n'+
   '  --inspect | --apply --align-ersen-before-29\n'+
   '  --host <production direct/session host> --password-file <owned0600 file> --ca-file <verified PEM> --evidence <new JSONL>\n'+
   'Requires all12 prebuilt indexes. Apply performs62 transactions, exact order; Ersen CAS is inside transaction29.\n'+
   'lock_timeout1s; statement_timeout30s; transaction_timeout45s; idle-in-transaction10s.\n'+
   'Any uncertain COMMIT stops for read-only reconciliation. Keep the controlled quiet window until all62 finish.');return;
 }
 const options=parseMigrationArgs(args),plan=await buildMigrationPlan({expectedManifestSha256:options['manifest-sha256']});
 if(options.mode==='plan'){
  console.log(JSON.stringify({mode:'offline-plan',project_ref:PRODUCTION_PROJECT,manifest_sha256:plan.manifest_sha256,
   order_sha256:plan.order_sha256,migrations:plan.entries.map(({position,id,file,sha256,body_sha256,wrapped})=>
    ({position,id,file,sha256,body_sha256,outer_wrapper_removed:wrapped})),alignment_before_position:29,remote_connection:false}));return;
 }
 const ca=await readFile(resolve(options['ca-file']),'utf8');
 const certificates=ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)||[];
 if(!certificates.length||ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,'').trim())fail('CA_BUNDLE_INVALID');
 try{certificates.forEach(certificate=>new X509Certificate(certificate));}catch{fail('CA_BUNDLE_INVALID');}
 const connection={host:options.host,user:options.host===`db.${PRODUCTION_PROJECT}.supabase.co`?'postgres':`postgres.${PRODUCTION_PROJECT}`,
  database:'postgres',port:5432,ssl:{ca,rejectUnauthorized:true},transaction:false};
 try{assertConnectionTarget(connection);}catch{fail('CONNECTION_TARGET_UNCONFIRMED');}
 const journal=await open(resolve(options.evidence),'wx',0o600);
 try{
  connection.password=await readMigrationPassword(options['password-file']);
  const result=await runProductionMigrations({plan,connection,apply:options.mode==='apply',alignErsen:options.alignErsen===true,
   record:async event=>{await journal.appendFile(JSON.stringify(event)+'\n');await journal.sync();
    if(['started','migration-start','migration-committed'].includes(event.event))console.log(JSON.stringify(event));}});
  console.log(JSON.stringify(result));if(result.status==='failed')process.exitCode=1;
 }finally{connection.password=undefined;await journal.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2))
 .catch(error=>{console.error(JSON.stringify({status:'failed',...safeMigrationFailure(error)}));process.exitCode=1;});
