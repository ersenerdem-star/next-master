import {test} from 'node:test';
import assert from 'node:assert/strict';
import {maintainIndexes,indexes} from '../catalog/lib/elring-completion-maintenance.mjs';
import {readSafeFetch} from '../catalog/lib/elring-read-fetch.mjs';
test('only a read transport failure retries; writes and HTTP errors do not',async()=>{
 let calls=0;const network=async()=>{if(++calls===1)throw new TypeError('fetch failed');return{ok:true};};
 assert.equal((await readSafeFetch('https://example.test',{method:'GET'},network)).ok,true);assert.equal(calls,2);
 calls=0;await assert.rejects(readSafeFetch('https://example.test',{method:'POST'},network),/fetch failed/);assert.equal(calls,1);
 calls=0;const result=await readSafeFetch('https://example.test',{method:'GET'},async()=>{calls++;return{ok:false,status:500};});assert.equal(result.status,500);assert.equal(calls,1);
});
test('index maintenance is separate, bounded and health checked',async()=>{
 const calls=[];let checks=0;
 await maintainIndexes({run:'approved-run',health:async()=>{checks++;},request:async(path,body,timeout)=>{calls.push({path,body,timeout});return{data:{pages:0},ms:1};}});
 assert.deepEqual(calls.map(c=>c.body.input_index),indexes);assert.ok(calls.every(c=>c.timeout===50000));assert.equal(checks,12);
 assert.ok(calls.every(c=>c.path.endsWith('/maintain_elring_completion_index')));
});
test('contended maintenance retries its fixed index once without replaying Product writes',async()=>{
 const calls=[],waits=[];let first=true;
 await maintainIndexes({run:'run',health:async()=>{},wait:async ms=>{waits.push(ms);},request:async(path,body)=>{
  calls.push({path,body});if(first){first=false;throw Error('HTTP_500 {"code":"55P03"}');}return{data:{pages:0}};
 }});
 assert.equal(calls.length,7);assert.equal(calls[0].body.input_index,calls[1].body.input_index);assert.ok(waits.includes(1000));
 assert.ok(calls.every(c=>c.path.endsWith('/maintain_elring_completion_index')));
});
test('unhealthy portal cancels only the tagged run maintenance and stops',async()=>{
 let checks=0,finish;const calls=[];
 await assert.rejects(maintainIndexes({run:'approved-run',health:async()=>{if(++checks===2)throw Error('PORTAL_LATENCY_GUARD');},
  request:async(path,body)=>{calls.push({path,body});if(path.endsWith('/cancel_elring_completion_maintenance')){finish({data:{pages:0}});return{data:1};}return new Promise(resolve=>{finish=resolve;});}}),/PORTAL_LATENCY_GUARD/);
 assert.equal(calls.length,2);assert.equal(calls[1].path,'/rest/v1/rpc/cancel_elring_completion_maintenance');assert.deepEqual(calls[1].body,{input_run_id:'approved-run'});
});
