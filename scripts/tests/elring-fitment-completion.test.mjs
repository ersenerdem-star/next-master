import {test} from 'node:test';
import assert from 'node:assert/strict';
import {vehiclePlans,collectCompleteVehicles} from '../catalog/lib/elring-fitment-completion.mjs';
const article={articleNumber:'115.100',mfrName:'ELRING',dataSupplierId:10,genericArticles:[{legacyArticleId:42,linkageTargetTypes:['V','O','M']}]};
const pair=(id,type='P',linked=true)=>({articleLinkId:id+1000,linkingTargetId:id,linkingTargetType:type,linked});
const list=pairs=>({response:{status:200,data:{array:[{articleLinkages:{array:pairs}}]}}});
const details=(pairs,type)=>({response:{status:200,data:{array:pairs.map(p=>({articleLinkId:p.articleLinkId,linkingTargetId:p.linkingTargetId,linkedVehicles:{array:[{carId:p.linkingTargetId,linkingTargetType:type,manuDesc:type==='P'?'AUDI':'MAN',modelDesc:'Model '+p.linkingTargetId}]}}))}}});
test('all passenger/commercial targets are resolved; intrinsic vehicle cache retains exact product link evidence',async()=>{
 const calls=[],cache=new Map();
 const call=async(method,args)=>{calls.push({method,args});return method==='getArticleLinkedAllLinkingTarget4'?list([pair(1),pair(2,'O'),pair(3,'P',false)]):details(args.linkedArticlePairs.array,args.linkingTargetType);};
 const first=await collectCompleteVehicles(article,{call,vehiclesCache:cache});
 assert.equal(first.complete,true);assert.equal(first.coverage[0].pairs_count,2);assert.equal(first.vehicles.length,2);assert.equal(calls.length,3);
 assert.deepEqual(first.coverage[0].target_keys,['P:1','O:2']);assert.equal(calls[0].args.linkingTargetType,'PO');assert.equal(calls[0].args.linkingTargetManuId,undefined);
 const second=await collectCompleteVehicles({...article,articleNumber:'116.100'},{call,vehiclesCache:cache});
 assert.equal(calls.length,4);assert.equal(second.vehicles.length,2);assert.equal(second.coverage[0].resolved_count,2);
 assert.notEqual(first.evidence_manifest_sha256,second.evidence_manifest_sha256);
});
test('detail chunks stay at 25 and every target must resolve before completion',async()=>{
 const pairs=Array.from({length:60},(_,i)=>pair(i+1));const sizes=[];
 const complete=await collectCompleteVehicles(article,{call:async(method,args)=>{if(method==='getArticleLinkedAllLinkingTarget4')return list(pairs);sizes.push(args.linkedArticlePairs.array.length);return details(args.linkedArticlePairs.array,args.linkingTargetType);}});
 assert.deepEqual(sizes,[25,25,10]);assert.equal(complete.vehicles.length,60);assert.equal(complete.coverage[0].resolved_count,60);
 await assert.rejects(collectCompleteVehicles(article,{call:async method=>method==='getArticleLinkedAllLinkingTarget4'?list([pair(1)]):{response:{status:200,data:{array:[]}}}}),/MISSING_OR_AMBIGUOUS/);
});
test('engine, axle and universal target classes do not invent vehicle models',async()=>{
 assert.deepEqual(vehiclePlans({...article,genericArticles:[{legacyArticleId:42,linkageTargetTypes:['M','A','U']}]}),[]);
 const empty=await collectCompleteVehicles({...article,genericArticles:[]},{call:async()=>{throw Error('Unexpected source call');}});
 assert.equal(empty.complete,true);assert.deepEqual(empty.vehicles,[]);assert.deepEqual(empty.coverage,[]);
 await assert.rejects(collectCompleteVehicles({...article,mfrName:'OTHER'},{call:async()=>{}}),/IDENTITY/);
});
