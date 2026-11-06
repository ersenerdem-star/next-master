import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BOSCH_DESCRIPTION_SCOPE as scope,applyBoschDescriptions,assertDescriptionOnlyChange,correctionPatchRequest,exactCode,parseArgs,readJsonl,readProductionCredentials,selectMatchedResults,validateCredentials,validateManifest,validateMatchedResult} from '../maintenance/apply-bosch-spareto-descriptions.mjs';

const id='10000000-0000-4000-8000-000000000001',id2='10000000-0000-4000-8000-000000000002';
const code='0242140572',stamp='2026-11-06T17:00:00.000Z';
const candidate={id,product_code:code,normalized_code:code,description:code,updated_at:'2026-06-18T13:56:09.792+00:00'};
const manifest={organizationId:scope.organizationId,brandId:scope.brandId,brand:'Bosch',capturedAt:'2026-11-06T16:21:20.860Z',count:1,rows:[candidate]};
const result={id,product_code:code,status:'matched',newDescription:'Spark Plug',sourceUrl:'https://spareto.com/products/bosch-spark-plug/0-242-140-572',sourceBrand:'BOSCH',sourceCode:'0 242 140 572',observedAt:'2026-11-06T16:24:33.712Z',method:'spareto_product_h1_live'};
const credentials={supabaseUrl:`https://${scope.projectRef}.supabase.co`,serviceRoleKey:'sb_secret_fixture_test_only'};
const before={...candidate,organization_id:scope.organizationId,brand_id:scope.brandId,description_tr:null,oem_no:'001234; 001235',ean:'04011234567890',origin:'DE',hs_code:'85111000',weight_kg:0.044,dimensions:{height_mm:22.5},vehicle:'Mercedes-Benz',vehicle_model:'C-Class',market_segment:'pc',image_url:'https://example.invalid/image.jpg',lifecycle_status:'active',lifecycle_note:null,created_at:'2026-05-01T10:00:00Z',search_text:'old search'};
const now=()=>new Date(stamp);
async function temporary(run){const outputDir=await mkdtemp(path.join(os.tmpdir(),'bosch-description-test-'));try{await run(outputDir);}finally{await rm(outputDir,{recursive:true,force:true});}}
function fixture({row=before,after,casMiss=false,patchError=false,getError=false,onPatch}={}){
  const calls=[];
  const fetchImpl=async(input,init)=>{
    const url=new URL(input),method=init.method||'GET';calls.push({url,init,method});
    assert.equal(url.origin,credentials.supabaseUrl);assert.equal(url.pathname,'/rest/v1/catalog_products');assert.equal(url.searchParams.get('organization_id'),`eq.${scope.organizationId}`);assert.equal(url.searchParams.get('brand_id'),`eq.${scope.brandId}`);assert.equal(url.searchParams.get('id'),`eq.${id}`);assert.equal(url.searchParams.get('select'),'*');
    if(method==='GET')return getError?Response.json({error:'private database error'},{status:503}):Response.json(row?[row]:[]);
    assert.equal(method,'PATCH');await onPatch?.(url,init);if(patchError)throw Error('private token: must never escape');
    const payload=JSON.parse(init.body);return Response.json(casMiss?[]:[after||{...row,...payload,search_text:'new search'}]);
  };
  return {calls,fetchImpl};
}

test('frozen manifest binds one production org/brand and preserves leading-zero code identity',()=>{
  assert.equal(validateManifest(manifest).get(id).product_code,'0242140572');assert.equal(exactCode('0 242 140 572'),'0242140572');
  for(const change of [{organizationId:id},{brandId:id},{brand:'SKF'},{count:2},{rows:[{...candidate,product_code:242140572}]},{rows:[{...candidate,description:'Existing true description'}]}])assert.throws(()=>validateManifest({...manifest,...change}),/MANIFEST_/);
  assert.throws(()=>validateManifest({...manifest,count:2,rows:[candidate,candidate]}),/IDENTITY/);
  assert.throws(()=>validateCredentials({...credentials,supabaseUrl:'https://staging.supabase.co'}),/PRODUCTION_PROJECT_MISMATCH/);
  assert.throws(()=>validateCredentials({...credentials,serviceRoleKey:'anon-fixture'}),/SERVICE_ROLE/);
});

test('only exact live Bosch product headings with valid source URLs and descriptions qualify',()=>{
  const match=validateMatchedResult(result,candidate,manifest,{now:now().getTime()});assert.equal(match.newDescription,'Spark Plug');assert.match(match.proofSha256,/^[a-f0-9]{64}$/);
  const changes=[{sourceBrand:'TRW'},{sourceCode:'242140572'},{product_code:'242140572'},{method:'url_slug_guess'},{newDescription:code},{newDescription:'0 242 140 572'},{newDescription:'BOSCH'},{newDescription:'No description'},{newDescription:'<script>text</script>'},{newDescription:'7'.repeat(12)},{newDescription:'a'.repeat(501)},{sourceUrl:'https://spareto.com.evil.invalid/products/bosch-spark-plug/0-242-140-572'},{sourceUrl:'https://user@spareto.com/products/bosch-spark-plug/0-242-140-572'},{sourceUrl:'https://spareto.com/products/trw-spark-plug/0-242-140-572'},{sourceUrl:'https://spareto.com/products/bosch-spark-plug/242-140-572'},{sourceUrl:result.sourceUrl+'?tracking=1'},{sourceUrl:result.sourceUrl+'#other'},{observedAt:'2026-10-01T12:00:00Z'},{observedAt:'2099-01-01T12:00:00Z'}];
  for(const change of changes)assert.throws(()=>validateMatchedResult({...result,...change},candidate,manifest,{now:now().getTime()}),/RESULT_/,JSON.stringify(change));
});

test('unmatched or invalid records never become work; conflicting confirmed titles hold the ID',()=>{
  const selected=selectMatchedResults(manifest,[{...result,status:'not_found'},{...result,sourceBrand:'TRW'}],{now:now().getTime()});assert.equal(selected.matches.length,0);assert.equal(selected.held.length,1);
  const conflict=selectMatchedResults(manifest,[result,{...result,newDescription:'Fuel Injector'}],{now:now().getTime()});assert.equal(conflict.matches.length,0);assert.equal(conflict.held[0].reason,'RESULT_CONFLICTING_LIVE_DESCRIPTIONS');
  const duplicate=selectMatchedResults(manifest,[result,{...result,observedAt:'2026-11-06T16:25:00Z'}],{now:now().getTime()});assert.equal(duplicate.matches.length,1);assert.equal(duplicate.matches[0].observedAt,'2026-11-06T16:25:00Z');
});

test('default CLI and runner are read-only, fresh-read only confirmed IDs and never read env on import',async()=>{
  assert.equal(parseArgs(['--manifest','/fixture/candidates.json']).apply,false);assert.equal(parseArgs(['--manifest=/fixture/candidates.json','--apply']).apply,true);
  assert.throws(()=>parseArgs(['--manifest','x','--limit=0']),/LIMIT_INVALID/);assert.throws(()=>parseArgs(['--manifest','x','--unknown']),/ARGUMENT_INVALID/);
  await temporary(async outputDir=>{
    const f=fixture();const summary=await applyBoschDescriptions({manifest,records:[result,{id:id2,status:'not_found'}],credentials,outputDir,fetchImpl:f.fetchImpl,now});
    assert.equal(summary.mode,'dry-run');assert.deepEqual(summary.outcomes,{planned:1});assert.deepEqual(f.calls.map(call=>call.method),['GET']);
    const [plan]=await readJsonl(summary.resultPath);assert.deepEqual(plan.payload,{description:'Spark Plug',updated_at:stamp});assert.deepEqual(plan.before,before);
    await assert.rejects(readFile(path.join(outputDir,'description-before.jsonl')),/ENOENT/);
  });
});

test('apply fsyncs full backup before narrow CAS PATCH and verifies all unrelated fields',async()=>{
  await temporary(async outputDir=>{
    const f=fixture({onPatch:async(url,init)=>{
      const [backup]=await readJsonl(path.join(outputDir,'description-before.jsonl'));assert.deepEqual(backup.before,before);assert.equal(backup.sourceProof.sourceCode,'0 242 140 572');
      assert.deepEqual(JSON.parse(init.body),{description:'Spark Plug',updated_at:stamp});assert.equal(init.headers.Prefer,'return=representation');
      assert.equal(url.searchParams.get('product_code'),`eq.${code}`);assert.equal(url.searchParams.get('description'),`eq.${code}`);assert.equal(url.searchParams.get('updated_at'),`eq.${before.updated_at}`);
    }});
    const summary=await applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:f.fetchImpl,now});assert.deepEqual(summary.outcomes,{applied:1});
    const [receipt]=await readJsonl(summary.resultPath);assert.deepEqual(receipt.before,before);assert.equal(receipt.after.product_code,code);assert.equal(receipt.after.ean,'04011234567890');assert.equal(receipt.after.origin,'DE');assert.equal(receipt.after.description,'Spark Plug');
    assert.equal(JSON.stringify(receipt).includes(credentials.serviceRoleKey),false);
    assertDescriptionOnlyChange(before,{...before,description:'Spark Plug',updated_at:stamp,search_text:'derived'},'Spark Plug',stamp);
    assert.throws(()=>assertDescriptionOnlyChange(before,{...before,description:'Spark Plug',updated_at:stamp,weight_kg:10},'Spark Plug',stamp),/UNEXPECTED_CATALOG_FIELD_CHANGED/);
  });
});

test('changed frozen description, identity or CAS timestamp never gets overwritten',async()=>{
  for(const change of [{description:'Manual corrected name'},{product_code:'242140572'},{organization_id:id2},{brand_id:id2},{updated_at:null}])await temporary(async outputDir=>{
    const f=fixture({row:{...before,...change}});const summary=await applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:f.fetchImpl,now});assert.deepEqual(summary.outcomes,{held:1});assert.equal(f.calls.filter(call=>call.method==='PATCH').length,0);
  });
  await temporary(async outputDir=>{
    const f=fixture({casMiss:true});const summary=await applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:f.fetchImpl,now});assert.deepEqual(summary.outcomes,{held:1});const [receipt]=await readJsonl(summary.resultPath);assert.equal(receipt.reason,'COMPARE_AND_SWAP_MISSED');
  });
  assert.throws(()=>correctionPatchRequest(credentials.supabaseUrl,candidate,{...before,description:'Changed'},result,stamp),/CURRENT_DESCRIPTION_CHANGED/);
});

test('read failure cannot create a write; uncertain PATCH or unexpected trigger change stops with durable evidence',async()=>{
  await temporary(async outputDir=>{
    const f=fixture({getError:true});const summary=await applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:f.fetchImpl,now});assert.deepEqual(summary.outcomes,{read_failed:1});assert.deepEqual(f.calls.map(call=>call.method),['GET']);assert.equal((await readJsonl(summary.resultPath))[0].reason,'CATALOG_HTTP_503');
  });
  for(const options of [{patchError:true},{after:{...before,description:'Spark Plug',updated_at:stamp,origin:'CN'}}])await temporary(async outputDir=>{
    const f=fixture(options);await assert.rejects(applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:f.fetchImpl,now}),/PATCH_(?:OUTCOME_UNKNOWN|VERIFICATION_FAILED)_STOPPED/);
    const [receipt]=await readJsonl(path.join(outputDir,'description-apply-results.jsonl'));assert.equal(receipt.status,options.patchError?'outcome_unknown':'verification_failed');assert.equal(JSON.stringify(receipt).includes('private token'),false);
    assert.equal((await readJsonl(path.join(outputDir,'description-before.jsonl'))).length,1);
  });
});

test('resume skips confirmed applied IDs and an existing apply lock blocks concurrent writers',async()=>{
  await temporary(async outputDir=>{
    const f=fixture();await applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:f.fetchImpl,now});
    const rerun=await applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:()=>{throw Error('resumed ID must not request');},now});assert.deepEqual(rerun.outcomes,{already_applied:1});assert.equal((await readJsonl(path.join(outputDir,'description-before.jsonl'))).length,1);
    await writeFile(path.join(outputDir,'description-apply.lock'),'other process');
    await assert.rejects(applyBoschDescriptions({manifest,records:[result],credentials,outputDir,apply:true,fetchImpl:f.fetchImpl,now}),/APPLY_LOCK/);
  });
});

test('repeated limited batches advance beyond previously applied IDs without skipping the next product',async()=>{
  await temporary(async outputDir=>{
    const second={...candidate,id:id2,product_code:'0242140573',normalized_code:'0242140573',description:'0242140573'};
    const frozen={...manifest,count:2,rows:[candidate,second]};
    const records=[result,{...result,id:id2,product_code:second.product_code,sourceCode:'0 242 140 573',sourceUrl:'https://spareto.com/products/bosch-spark-plug/0-242-140-573'}];
    const reads=[],writes=[];
    const fetchImpl=async(input,init)=>{
      const requested=new URL(input).searchParams.get('id').slice(3),row={...before,...(requested===id?candidate:second)};
      if(init.method==='PATCH'){writes.push(requested);return Response.json([{...row,...JSON.parse(init.body)}]);}
      reads.push(requested);return Response.json([row]);
    };
    const first=await applyBoschDescriptions({manifest:frozen,records,credentials,outputDir,apply:true,limit:1,fetchImpl,now});assert.deepEqual(first.outcomes,{applied:1});
    const next=await applyBoschDescriptions({manifest:frozen,records,credentials,outputDir,apply:true,limit:1,fetchImpl,now});assert.deepEqual(next.outcomes,{already_applied:1,applied:1});assert.deepEqual(reads,[id,id2]);assert.deepEqual(writes,[id,id2]);
  });
});

test('private env is functions-scoped and errors never print credentials or CLI stderr',()=>{
  const calls=[];const value=readProductionCredentials('/fixture/production',{exec:(cmd,args,options)=>{calls.push({cmd,args,options});return args.includes('SUPABASE_URL')?credentials.supabaseUrl:credentials.serviceRoleKey;}});assert.deepEqual(value,credentials);
  assert.equal(calls.length,2);for(const call of calls){assert.deepEqual(call.args.slice(-4),['--context','production','--scope','functions']);assert.deepEqual(call.options.stdio,['ignore','pipe','pipe']);assert.equal(call.options.cwd,'/fixture/production');}
  assert.throws(()=>readProductionCredentials('/fixture/production',{exec:()=>{throw Error(credentials.serviceRoleKey);}}),error=>error.message==='PRIVATE_PRODUCTION_ENV_UNAVAILABLE');
  assert.throws(()=>readProductionCredentials('relative'),/ABSOLUTE_PATH_REQUIRED/);
});
