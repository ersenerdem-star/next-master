#!/usr/bin/env node
// Dry-run is the default. --apply is an explicit, description-only write.
// node scripts/maintenance/apply-bosch-spareto-descriptions.mjs \
//   --manifest /absolute/candidates.json --results /absolute/lookup-results.jsonl \
//   --env-project /absolute/production-linked-repo [--apply] [--limit 100]
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

export const BOSCH_DESCRIPTION_SCOPE=Object.freeze({
  projectRef:'zjgueqijumzlfioihnkt',
  organizationId:'1e4c5e99-e387-41aa-a6d3-cbe74558f766',
  brandId:'089669ff-5855-4abd-9bb7-e13b8d3f940f',
});
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sha=value=>createHash('sha256').update(value).digest('hex');
export const exactCode=value=>String(value??'').trim().replace(/\s+/g,'').toUpperCase();
const skuKey=value=>String(value??'').replace(/[^A-Z0-9]/gi,'').toUpperCase();
export const isSkuDescription=(description,code)=>typeof description==='string'&&Boolean(skuKey(code))&&skuKey(description)===skuKey(code);
const fail=code=>{throw new Error(code);};

export function validateManifest(manifest){
  const scope=BOSCH_DESCRIPTION_SCOPE;
  if(manifest?.organizationId!==scope.organizationId||manifest?.brandId!==scope.brandId||manifest?.brand!=='Bosch')fail('MANIFEST_SCOPE_INVALID');
  if(!Array.isArray(manifest.rows)||manifest.count!==manifest.rows.length||!Number.isFinite(Date.parse(manifest.capturedAt)))fail('MANIFEST_INVALID');
  const seen=new Set();
  for(const row of manifest.rows){
    if(!uuid(row?.id)||seen.has(row.id)||typeof row.product_code!=='string'||!exactCode(row.product_code)||row.product_code.length>100)fail('MANIFEST_ROW_IDENTITY_INVALID');
    if(!isSkuDescription(row.description,row.product_code))fail('MANIFEST_ROW_NOT_SKU_PLACEHOLDER');
    seen.add(row.id);
  }
  return new Map(manifest.rows.map(row=>[row.id,row]));
}

export function validateMatchedResult(result,candidate,manifest,{now=Date.now()}={}){
  if(!candidate||result?.id!==candidate.id||result.product_code!==candidate.product_code)fail('RESULT_CATALOG_IDENTITY_INVALID');
  if(result.status!=='matched'||result.method!=='spareto_product_h1_live'||String(result.sourceBrand||'').trim().toUpperCase()!=='BOSCH'||typeof result.sourceCode!=='string'||exactCode(result.sourceCode)!==exactCode(candidate.product_code))fail('RESULT_SOURCE_IDENTITY_INVALID');
  const observed=Date.parse(result.observedAt);
  if(!Number.isFinite(observed)||observed<Date.parse(manifest.capturedAt)-300000||observed>now+300000)fail('RESULT_OBSERVATION_TIME_INVALID');
  let url;
  try{url=new URL(result.sourceUrl);}catch{fail('RESULT_SOURCE_URL_INVALID');}
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.origin!=='https://spareto.com'||url.username||url.password||url.port||url.search||url.hash||parts.length!==3||parts[0]!=='products'||!/^bosch-[a-z0-9._~%-]+$/i.test(parts[1])||!/^[a-z0-9._~%-]+$/i.test(parts[2]))fail('RESULT_SOURCE_URL_INVALID');
  let urlCode;try{urlCode=decodeURIComponent(parts[2]);}catch{fail('RESULT_SOURCE_URL_INVALID');}
  if(skuKey(urlCode)!==skuKey(candidate.product_code))fail('RESULT_SOURCE_URL_CODE_MISMATCH');
  const description=typeof result.newDescription==='string'?result.newDescription.replace(/\s+/g,' ').trim():'';
  if(!description||description.length>500||!/[\p{L}]/u.test(description)||/[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(description)||isSkuDescription(description,candidate.product_code)||/^(?:bosch|n\/?a|unknown|no (?:description|product(?: name)?)|description(?: unavailable)?|not available|product|part)$/i.test(description))fail('RESULT_DESCRIPTION_INVALID');
  const proof={sourceUrl:url.href,sourceBrand:'BOSCH',sourceCode:result.sourceCode,observedAt:result.observedAt,method:result.method};
  return {id:candidate.id,product_code:candidate.product_code,newDescription:description,...proof,proofSha256:sha(JSON.stringify({...proof,newDescription:description}))};
}

export function selectMatchedResults(manifest,records,options){
  const candidates=validateManifest(manifest),matches=new Map(),held=new Map();
  for(const result of records){
    if(result?.status!=='matched')continue;
    try{
      const match=validateMatchedResult(result,candidates.get(result.id),manifest,options),previous=matches.get(match.id);
      if(previous&&previous.newDescription!==match.newDescription)fail('RESULT_CONFLICTING_LIVE_DESCRIPTIONS');
      if(!previous||Date.parse(match.observedAt)>=Date.parse(previous.observedAt))matches.set(match.id,match);
    }catch(error){held.set(String(result?.id||''),{id:result?.id||null,product_code:result?.product_code||null,status:'held',reason:error.message});}
  }
  for(const id of held.keys())matches.delete(id);
  return {matches:[...matches.values()],held:[...held.values()]};
}

export function validateCredentials({supabaseUrl,serviceRoleKey}){
  const base=String(supabaseUrl||'').replace(/\/+$/,'');
  if(base!==`https://${BOSCH_DESCRIPTION_SCOPE.projectRef}.supabase.co`)fail('PRODUCTION_PROJECT_MISMATCH');
  let service=String(serviceRoleKey||'').startsWith('sb_secret_');
  try{service ||= JSON.parse(Buffer.from(String(serviceRoleKey).split('.')[1]||'','base64url').toString()).role==='service_role';}catch{/* Fail closed below. */}
  if(!service)fail('SERVICE_ROLE_CREDENTIAL_REQUIRED');
  return {supabaseUrl:base,serviceRoleKey};
}

export function readProductionCredentials(envProject,{exec=execFileSync}={}){
  if(!envProject||!path.isAbsolute(envProject))fail('ENV_PROJECT_ABSOLUTE_PATH_REQUIRED');
  const get=name=>{
    try{
      return String(exec(path.join(envProject,'node_modules/.bin/netlify'),['env:get',name,'--context','production','--scope','functions'],{cwd:envProject,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024})||'').trim();
    }catch{fail('PRIVATE_PRODUCTION_ENV_UNAVAILABLE');}
  };
  return validateCredentials({supabaseUrl:get('SUPABASE_URL'),serviceRoleKey:get('SUPABASE_SERVICE_ROLE_KEY')});
}

const scopeUrl=(base,id)=>{
  const url=new URL('/rest/v1/catalog_products',base);
  url.searchParams.set('id',`eq.${id}`);url.searchParams.set('organization_id',`eq.${BOSCH_DESCRIPTION_SCOPE.organizationId}`);url.searchParams.set('brand_id',`eq.${BOSCH_DESCRIPTION_SCOPE.brandId}`);url.searchParams.set('select','*');
  return url;
};
export function correctionPatchRequest(base,candidate,before,match,updatedAt){
  if(before?.id!==candidate.id||before.organization_id!==BOSCH_DESCRIPTION_SCOPE.organizationId||before.brand_id!==BOSCH_DESCRIPTION_SCOPE.brandId||before.product_code!==candidate.product_code)fail('CURRENT_CATALOG_IDENTITY_CHANGED');
  if(before.description!==candidate.description||!isSkuDescription(before.description,candidate.product_code))fail('CURRENT_DESCRIPTION_CHANGED');
  if(typeof before.updated_at!=='string'||!Number.isFinite(Date.parse(before.updated_at)))fail('CURRENT_UPDATED_AT_INVALID');
  const url=scopeUrl(base,candidate.id);
  url.searchParams.set('product_code',`eq.${candidate.product_code}`);url.searchParams.set('description',`eq.${before.description}`);url.searchParams.set('updated_at',`eq.${before.updated_at}`);
  return {url:url.href,payload:{description:match.newDescription,updated_at:updatedAt}};
}

export function assertDescriptionOnlyChange(before,after,description,updatedAt){
  if(!after||after.description!==description||Date.parse(after.updated_at)!==Date.parse(updatedAt))fail('DESCRIPTION_WRITE_NOT_VERIFIED');
  const permitted=new Set(['description','updated_at','search_text']);
  const keys=new Set([...Object.keys(before),...Object.keys(after)]);
  if([...keys].some(key=>!permitted.has(key)&&!isDeepStrictEqual(before[key],after[key])))fail('UNEXPECTED_CATALOG_FIELD_CHANGED');
}

export async function readJsonl(file,{optional=false}={}){
  let value;try{value=await readFile(file,'utf8');}catch(error){if(optional&&error.code==='ENOENT')return [];throw error;}
  try{return value.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));}catch{fail('JSONL_INVALID');}
}
async function appendDurable(file,value){
  const handle=await open(file,'a',0o600);
  try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
}

export async function applyBoschDescriptions({manifest,records,credentials,outputDir,apply=false,limit=Infinity,fetchImpl=fetch,now=()=>new Date()}){
  const config=validateCredentials(credentials),selected=selectMatchedResults(manifest,records,{now:now().getTime()}),candidates=validateManifest(manifest);
  if(!(limit===Infinity||Number.isSafeInteger(limit)&&limit>0))fail('LIMIT_INVALID');
  if(!outputDir||!path.isAbsolute(outputDir))fail('OUTPUT_DIRECTORY_ABSOLUTE_PATH_REQUIRED');
  await mkdir(outputDir,{recursive:true});
  const manifestSha256=sha(JSON.stringify(manifest)),runId=randomUUID(),resultPath=path.join(outputDir,apply?'description-apply-results.jsonl':'description-dry-run-results.jsonl'),backupPath=path.join(outputDir,'description-before.jsonl');
  const previous=await readJsonl(path.join(outputDir,'description-apply-results.jsonl'),{optional:true});
  const appliedIds=new Set(previous.filter(row=>row.manifestSha256===manifestSha256&&row.status==='applied').map(row=>row.id));
  let lock;
  const lockPath=path.join(outputDir,'description-apply.lock');
  if(apply){try{lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({runId,pid:process.pid,startedAt:now().toISOString()}));}catch{await lock?.close();fail('APPLY_LOCK_EXISTS_OR_UNAVAILABLE');}}
  const headers={apikey:config.serviceRoleKey,Authorization:`Bearer ${config.serviceRoleKey}`,'Content-Type':'application/json'};
  const outcomes=[];
  const record=async row=>{const value={runId,manifestSha256,at:now().toISOString(),...row};await appendDurable(resultPath,value);outcomes.push(value);};
  const request=async(url,init={})=>{
    let response;try{response=await fetchImpl(url,{...init,headers:{...headers,...init.headers},cache:'no-store',signal:AbortSignal.timeout(15000)});}catch{fail('CATALOG_TRANSPORT_FAILED');}
    if(!response.ok)fail(`CATALOG_HTTP_${response.status}`);
    let rows;try{rows=await response.json();}catch{fail('CATALOG_RESPONSE_INVALID');}
    if(!Array.isArray(rows))fail('CATALOG_RESPONSE_INVALID');return rows;
  };
  try{
    for(const held of selected.held)await record(held);
    let attempted=0;
    for(const match of selected.matches){
      const candidate=candidates.get(match.id),identity={id:match.id,product_code:candidate.product_code,sourceProof:match};
      if(appliedIds.has(match.id)){await record({...identity,status:'already_applied'});continue;}
      // Limit new attempts, rather than slicing the manifest before resume;
      // otherwise repeated --limit batches would revisit only applied IDs.
      if(attempted>=limit)break;
      attempted++;
      const readUrl=scopeUrl(config.supabaseUrl,match.id);readUrl.searchParams.set('limit','2');
      let rows;
      try{rows=await request(readUrl.href);}catch(error){await record({...identity,status:'read_failed',reason:error.message});continue;}
      if(rows.length!==1){await record({...identity,status:'held',reason:'CURRENT_CATALOG_ROW_NOT_UNIQUE'});continue;}
      const before=rows[0],updatedAt=now().toISOString();let patch;
      try{patch=correctionPatchRequest(config.supabaseUrl,candidate,before,match,updatedAt);}catch(error){await record({...identity,status:'held',reason:error.message});continue;}
      if(!apply){await record({...identity,status:'planned',before,payload:patch.payload});continue;}
      // The complete original row and source proof are fsynced before dispatch.
      const backupId=randomUUID();await appendDurable(backupPath,{runId,manifestSha256,backupId,at:now().toISOString(),...identity,before,payload:patch.payload});
      let afterRows;
      try{afterRows=await request(patch.url,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(patch.payload)});}
      catch(error){await record({...identity,backupId,status:'outcome_unknown',reason:error.message});fail('PATCH_OUTCOME_UNKNOWN_STOPPED');}
      if(!afterRows.length){await record({...identity,backupId,status:'held',reason:'COMPARE_AND_SWAP_MISSED'});continue;}
      try{if(afterRows.length!==1)fail('DESCRIPTION_WRITE_NOT_UNIQUE');assertDescriptionOnlyChange(before,afterRows[0],match.newDescription,updatedAt);}
      catch(error){await record({...identity,backupId,status:'verification_failed',reason:error.message,before,after:afterRows});fail('PATCH_VERIFICATION_FAILED_STOPPED');}
      await record({...identity,backupId,status:'applied',before,after:afterRows[0]});
    }
  }finally{if(lock){await lock.close();await unlink(lockPath);}}
  return {mode:apply?'apply':'dry-run',manifestSha256,candidates:manifest.rows.length,confirmedMatches:selected.matches.length,heldSourceResults:selected.held.length,outcomes:outcomes.reduce((counts,row)=>({...counts,[row.status]:(counts[row.status]||0)+1}),{}),resultPath,...(apply?{backupPath}:{})};
}

export function parseArgs(argv){
  const options={apply:false};
  for(let index=0;index<argv.length;index++){
    if(argv[index]==='--apply'){options.apply=true;continue;}
    const match=argv[index].match(/^--(manifest|results|output-dir|env-project|limit)(?:=(.*))?$/);if(!match)fail('ARGUMENT_INVALID');
    const value=match[2]??argv[++index];if(!value||value.startsWith('--'))fail('ARGUMENT_VALUE_REQUIRED');options[match[1]]=value;
  }
  if(!options.manifest)fail('MANIFEST_PATH_REQUIRED');
  if(options.limit!==undefined&&!/^[1-9]\d*$/.test(options.limit))fail('LIMIT_INVALID');
  return options;
}
export async function runCli(argv=process.argv.slice(2)){
  const args=parseArgs(argv),manifestPath=path.resolve(args.manifest),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  // Validate all local inputs before accessing the private production env.
  const records=await readJsonl(path.resolve(args.results||path.join(path.dirname(manifestPath),'lookup-results.jsonl')));
  validateManifest(manifest);selectMatchedResults(manifest,records);
  const credentials=readProductionCredentials(args['env-project']||process.env.BOSCH_ENV_PROJECT||'');
  const summary=await applyBoschDescriptions({manifest,records,credentials,outputDir:path.resolve(args['output-dir']||path.dirname(manifestPath)),apply:args.apply,limit:args.limit?Number(args.limit):Infinity});
  console.log(JSON.stringify(summary,null,2));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runCli().catch(error=>{console.error(JSON.stringify({status:'failed',reason:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'DESCRIPTION_CLEANUP_FAILED'}));process.exitCode=1;});
}
