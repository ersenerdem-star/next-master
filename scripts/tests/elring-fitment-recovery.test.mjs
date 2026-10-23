import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readOfficialRequest} from '../catalog/lib/elring-source-request.mjs';
import {applyConfirmedFitment,verifySlowFitmentAcknowledgement} from '../catalog/lib/elring-fitment-apply.mjs';
test('official source retries only transient reads and counts each bounded attempt',async()=>{
 const attempts=[],waits=[];let calls=0;
 const response=await readOfficialRequest({read:'only'},{beforeAttempt:async a=>attempts.push(a),wait:async ms=>waits.push(ms),
  fetchImpl:async()=>++calls===1?new Response('',{status:503}):new Response('{"status":200,"data":{"array":[]}}')});
 assert.equal(response.status,200);assert.deepEqual(attempts,[0,1]);assert.deepEqual(waits,[2000]);
 calls=0;await assert.rejects(readOfficialRequest({}, {fetchImpl:async()=>{calls++;return new Response('',{status:400});},wait:async()=>{}}),/SOURCE_HTTP_400/);assert.equal(calls,1);
 calls=0;await assert.rejects(readOfficialRequest({}, {fetchImpl:async()=>{calls++;throw new TypeError('fetch failed');},wait:async()=>{}}),/fetch failed/);assert.equal(calls,3);
});
const evidence={evidence_manifest_sha256:'proof',stage_fingerprint:'stage'};
test('slow acknowledged vehicle write holds further writes until health, receipt and separate maintenance pass',async()=>{
 let waited=0,checks=0,maintained=0;const calls=[];
 const result=await verifySlowFitmentAcknowledgement({run:'run',row:0,evidence,wait:async ms=>{waited=ms;},health:async()=>{checks++;},maintenance:async()=>{maintained++;},
  request:async(path,body)=>{assert.equal(body,undefined);calls.push(path);return{data:path.includes('completion_jobs')?[{cursor:0}]:[{after_fields:{evidence_manifest_sha256:'proof'},evidence_fingerprint:'stage'}]};}});
 assert.equal(waited,5000);assert.equal(checks,2);assert.equal(maintained,1);assert.equal(calls.length,2);assert.equal(result.cursor,0);
 await assert.rejects(verifySlowFitmentAcknowledgement({run:'run',row:0,evidence,wait:async()=>{},health:async()=>{},maintenance:async()=>{throw Error('Must not maintain after invalid receipt');},request:async()=>({data:[]})}),/SLOW_FITMENT_RECEIPT_MISMATCH/);
});
test('ambiguous fitment response is acknowledged through exact committed receipt without replay',async()=>{
 let posts=0,maintenance=0;const recovery=[];
 const result=await applyConfirmedFitment({run:'run',row:0,evidence,health:async()=>{},maintenance:async()=>{maintenance++;},onRecovery:async r=>recovery.push(r),
  request:async(path,body)=>{if(body){posts++;throw new TypeError('fetch failed');}return{data:path.includes('completion_jobs')?[{cursor:0,processed:1}]:[{after_fields:{evidence_manifest_sha256:'proof'},evidence_fingerprint:'stage'}]};}});
 assert.equal(posts,1);assert.equal(maintenance,0);assert.equal(result.data.processed,1);assert.equal(recovery[0].result,'committed_receipt_verified');
});
test('uncommitted exact row may replay once only after checkpoint, health and maintenance',async()=>{
 let posts=0,maintenance=0;
 const result=await applyConfirmedFitment({run:'run',row:0,evidence,health:async()=>{},maintenance:async()=>{maintenance++;},request:async(path,body)=>{
  if(body){if(++posts===1)throw new TypeError('fetch failed');return{data:{processed:1},ms:1};}
  return{data:path.includes('completion_jobs')?[{cursor:-1}]:[]};}});
 assert.equal(posts,2);assert.equal(maintenance,1);assert.equal(result.data.processed,1);
 await assert.rejects(applyConfirmedFitment({run:'run',row:0,evidence,health:async()=>{},request:async(path,body)=>{
  if(body)throw new TypeError('fetch failed');return{data:path.includes('completion_jobs')?[{cursor:0}]:[{after_fields:{evidence_manifest_sha256:'wrong'},evidence_fingerprint:'stage'}]};}}),/AMBIGUOUS_CHECKPOINT/);
});
