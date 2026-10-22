import {test} from 'node:test';import assert from 'node:assert/strict';
import {dispatchCatalogBrand} from '../../netlify/functions/_shared/catalog/brand-dispatch-worker.mts';
import {requireBrandDispatch} from '../../netlify/functions/_shared/catalog/brand-dispatch.mts';
const target={portal:'https://portal.next-master.com',key:'test-only-key'},job={id:crypto.randomUUID(),organization_id:crypto.randomUUID(),status:'queued'};
test('a selected job is signed for its exact organization and leaves claiming to the worker',async()=>{
 const calls=[];const db={rpc:async(name,args)=>{calls.push([name,args]);return {data:job};}};
 const result=await dispatchCatalogBrand({db,target,send:async(url,options)=>{assert.equal(url,target.portal+'/api/catalog-brand-worker-background');const body=JSON.parse(options.body);assert.deepEqual(body,{jobId:job.id,organizationId:job.organization_id});requireBrandDispatch(new Request(url,options),target.key,job.id,job.organization_id);assert.equal(options.redirect,'error');return new Response(null,{status:202});}});
 assert.equal(result.jobId,job.id);assert.deepEqual(calls,[['next_catalog_brand_dispatch',{}]]);
});
test('a paused job resumes its existing cursor without enabling publication',async()=>{
 const calls=[];await dispatchCatalogBrand({db:{rpc:async(name,args)=>{calls.push([name,args]);return {data:{...job,status:'paused'}};}},target,send:async()=>new Response(null,{status:202})});
 assert.deepEqual(calls[1],['schedule_catalog_brand_job',{input_org:job.organization_id,input_job:job.id,input_publish:false}]);
});
test('a busy organization or an empty queue causes no admission or network call',async()=>{
 const result=await dispatchCatalogBrand({db:{rpc:async()=>({data:null})},target,send:async()=>{throw Error('must not send');}});assert.equal(result.status,'idle');
});
test('database and HTTP dispatch failures are reported without fabricating a successful run',async()=>{
 await assert.rejects(dispatchCatalogBrand({db:{rpc:async()=>({error:{message:'unavailable'}})},target,send:async()=>{throw Error('must not send');}}),/SELECTION_FAILED/);
 await assert.rejects(dispatchCatalogBrand({db:{rpc:async()=>({data:job})},target,send:async()=>new Response(null,{status:403})}),/HTTP_403/);
});
