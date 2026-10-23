import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportStageTiming} from '../../netlify/functions/_shared/export-stage-timing.mts';
test('timing preserves business result and original error without logging payloads or private errors',async()=>{
 const logs:any[]=[];const measure=createExportStageTiming('job','run',v=>logs.push(v));
 const result={privatePrice:123,token:'PRIVATE'};assert.equal(await measure('assemble-xlsx',async()=>result),result);
 const error=Error('PRIVATE_CREDENTIAL');await assert.rejects(measure('commit-artifact',async()=>{throw error;}),e=>e===error);
 assert.deepEqual(logs.map(v=>v.ok),[true,false]);assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|privatePrice|token/);
 assert.ok(logs.every(v=>Number.isInteger(v.durationMs)&&v.durationMs>=0&&Number.isInteger(v.rssMiB)));
});
test('broken telemetry cannot fail an otherwise successful fenced stage',async()=>{
 const measure=createExportStageTiming('job','run',()=>{throw Error('logging unavailable');});
 assert.equal(await measure('authorized-snapshot',async()=>42),42);
});
