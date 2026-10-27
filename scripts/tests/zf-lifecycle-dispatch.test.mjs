import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatchZfLifecycle,requireZfDispatch,zfDispatchSignature} from '../../netlify/functions/_shared/catalog/zf-dispatch.mts';

const job='11111111-1111-4111-8111-111111111111';
const org='22222222-2222-4222-8222-222222222222';
const target={portal:'https://portal.next-master.com',key:'test-service-key'};
const row={id:job,organization_id:org,status:'paused',created_at:'2026-10-27T00:00:00Z'};
function database({active=false,pending=row,expired=null}={}){
 const calls=[];
 let queryNumber=0;
 const builder={
  eq(){return this;},in(){return this;},gt(){return this;},lt(){return this;},order(){return this;},
  limit(){queryNumber++;
   const data=queryNumber===1?(active?[row]:[]):queryNumber===2?(pending?[pending]:[]):(expired?[expired]:[]);
   return Promise.resolve({data,error:null});
  },
 };
 const db={
  from(table){assert.equal(table,'catalog_zf_jobs');return {select(){return builder;}};},
  rpc(name,args){calls.push(['rpc',name,args]);return Promise.resolve({data:{},error:null});},
 };
 return {calls,db};
}

test('signed ZF lifecycle dispatch cannot be forged',()=>{
 const time=String(Date.now());
 const request=new Request('https://portal.next-master.com/api/catalog-zf-worker-background',{
  headers:{'x-catalog-time':time,'x-catalog-signature':zfDispatchSignature(target.key,job,org,time)}});
 assert.doesNotThrow(()=>requireZfDispatch(request,target.key,job,org));
 assert.throws(()=>requireZfDispatch(request,target.key,job,'33333333-3333-4333-8333-333333333333'));
});

test('active ZF job stops a second dispatch',async()=>{
 const {db}=database({active:true});let sends=0;
 const result=await dispatchZfLifecycle({db,target,send:async()=>{sends++;return {ok:true};}});
 assert.deepEqual(result,{status:'busy'});assert.equal(sends,0);
});

test('paused ZF lifecycle job resumes and dispatches to fixed portal',async()=>{
 const {db,calls}=database();let sent;
 const result=await dispatchZfLifecycle({db,target,send:async(url,init)=>{sent={url,init};return {ok:true};}});
 assert.equal(result.jobId,job);
 assert.deepEqual(calls.find(c=>c[0]==='rpc'),['rpc','schedule_catalog_zf_job',{input_org:org,input_job:job,input_publish:false}]);
 assert.equal(sent.url,'https://portal.next-master.com/api/catalog-zf-worker-background');
 const request=new Request(sent.url,{headers:sent.init.headers});
 assert.doesNotThrow(()=>requireZfDispatch(request,target.key,job,org));
});

test('after reviewed packages, scheduler creates one next package and dispatches it',async()=>{
 let jobQuery=0,sent=0,rpcCount=0;
 const chain=data=>({eq(){return this;},in(){return this;},gt(){return this;},lt(){return this;},order(){return this;},limit(){return Promise.resolve({data,error:null});}});
 const db={
  from(table){return {select(){return table==='catalog_external_sources'?chain([{organization_id:org}]):chain((++jobQuery,[]));}};},
  rpc(name,args){assert.equal(name,'enqueue_next_catalog_zf_lifecycle_job');assert.equal(args.input_org,org);rpcCount++;
   return Promise.resolve({data:{id:job,organization_id:org,status:'queued'},error:null});},
 };
 const result=await dispatchZfLifecycle({db,target,send:async()=>{sent++;return {ok:true};}});
 assert.deepEqual(result,{status:'dispatched',jobId:job});assert.equal(rpcCount,1);assert.equal(sent,1);
});
