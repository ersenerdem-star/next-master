import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {actionScope,parseReleaseActionEvidence,prepareDurableAction,publicationConfirmationKey,publishCommand,readDurableAction,
  reconcileDurableAction,releaseActionsTargetEnabled,releasePublicationReady,reviewCommand,updateDurableAction,
  type ActionReceipt,type DurableAction,type ReleaseActionEvidence} from '../../apps/web/src/shared/supplierReleaseActions.ts';
import {createSupplierReleaseActionsClient,SupplierReleaseActionError} from '../../apps/web/src/infrastructure/api/supplierReleaseActionsApi.ts';
import {SupplierReleaseActionView} from '../../apps/web/src/modules/admin/SupplierReleaseActionPanel.tsx';

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const origin='https://portal.next-master.com';
const evidence:ReleaseActionEvidence={actorId:id(1),organizationId:id(2),releaseId:id(3),supplierId:id(4),brandId:id(5),supplier:'GEBA',brand:'Geba',
  mode:'replace',status:'validated',reviewRevision:2,errorCode:null,
  brandIdentityAudit:{policy:'cross-brand-v1',checked:true,review_required:false,selected_brand_id:id(5),distinct_incoming_codes:108,brands:[]},
  totalRows:108,processedRows:108,acceptedRows:108,rejectedRows:0,warningRows:0,conflictRows:0,sourceVerified:true,
  currentPublicationId:id(6),currentReleaseId:id(7),currentPublicationVersion:3,isCurrent:false,canReview:false,canPublish:true,reviewOperation:null,publishOperation:null};
const held:ReleaseActionEvidence={...evidence,status:'staged',errorCode:'BRAND_IDENTITY_REVIEW_REQUIRED',canReview:true,canPublish:false,
  brandIdentityAudit:{...evidence.brandIdentityAudit,review_required:true}};
function storage() {
  const map=new Map<string,string>();
  return {map,getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},removeItem:(key:string)=>{map.delete(key);}};
}
function client(transport:typeof fetch,actorId=id(1),enabled=true) {
  return createSupplierReleaseActionsClient({enabled:()=>enabled,origin:()=>origin,getAuth:async()=>({token:'synthetic-access-token',actorId}),transport});
}
const queued=(r:DurableAction):ActionReceipt=>({releaseId:r.scope.releaseId,decisionId:r.command.decisionId,status:'queued',published:false,replayed:false,
  action:r.kind==='publish'?'publish':'recheck'});
const published=(r:DurableAction):ActionReceipt=>({releaseId:r.scope.releaseId,decisionId:r.command.decisionId,status:'published',published:true,replayed:false,
  publicationId:id(20),version:4,reviewRevision:2,expectedPreviousPublicationId:id(6),isCurrent:true});

test('independent browser gates reject default, wrong origin/ref and mixed production/staging configuration',()=>{
  assert.equal(releaseActionsTargetEnabled({}),false);
  const prod={enabled:'true',productionEnabled:'1',productionTarget:'zjgueqijumzlfioihnkt',supabaseUrl:'https://zjgueqijumzlfioihnkt.supabase.co',origin};
  assert.equal(releaseActionsTargetEnabled(prod),true);
  for(const patch of [{enabled:'1'},{productionEnabled:undefined},{productionTarget:undefined},{origin:'https://example.invalid'},
    {supabaseUrl:'https://kaxsqafdevabkxofwdod.supabase.co'},{supabaseUrl:prod.supabaseUrl+'/'}])assert.equal(releaseActionsTargetEnabled({...prod,...patch}),false);
  assert.equal(releaseActionsTargetEnabled({enabled:'true',supabaseUrl:'https://kaxsqafdevabkxofwdod.supabase.co',origin:'https://next-master-v3-staging-20261006.netlify.app'}),true);
});

test('timeout then reload resubmits byte-identical review decision, not refreshed CAS or another decision',async()=>{
  const s=storage(),scope=actionScope(held,origin);
  let saved=prepareDurableAction(s,scope,'review',reviewCommand(held,'comparison_repaired',id(10)));
  const bodies:string[]=[];
  const first=client(async(_url,init)=>{bodies.push(String(init?.body));throw new DOMException('timeout','TimeoutError');});
  await assert.rejects(first.submit(saved),(error:SupplierReleaseActionError)=>{
    assert.equal(error.outcome,'unknown');saved=updateDurableAction(s,saved,{errorCode:error.code,unknown:true});return true;
  });
  const restored=readDurableAction(s,scope,'review')!;
  assert.equal(restored.phase,'unknown');
  const latest={...evidence,reviewRevision:9};
  assert.deepEqual(prepareDurableAction(s,scope,'review',reviewCommand(latest,'wrong_source_file',id(11))).command,restored.command);
  const replay=client(async(_url,init)=>{bodies.push(String(init?.body));return Response.json({error:'stale',code:'REVIEW_REVISION_STALE',outcome:'not_submitted'},{status:409});});
  await assert.rejects(replay.submit(restored),(error:SupplierReleaseActionError)=>{
    assert.equal(error.outcome,'not_submitted');saved=updateDurableAction(s,restored,{errorCode:error.code});return true;
  });
  assert.equal(bodies[0],bodies[1]);assert.equal(JSON.parse(bodies[1]).expectedRevision,2);
  assert.equal(saved.phase,'failed');assert.equal(saved.command.decisionId,id(10));
  assert.doesNotMatch([...s.map.values()].join(''),/synthetic-access-token/);
});

test('async review completion refreshes clear evidence but never sends publication automatically',async()=>{
  const s=storage(),scope=actionScope(held,origin),calls:string[]=[];
  let saved=prepareDurableAction(s,scope,'review',reviewCommand(held,'comparison_repaired',id(12)));
  const receipt:ActionReceipt={releaseId:held.releaseId,decisionId:id(12),action:'recheck',status:'rechecked_clear',reviewRevision:3,errorCode:null,published:false,replayed:false};
  const fresh={...evidence,reviewRevision:3,reviewOperation:{decisionId:id(12),status:'completed',receipt,errorCode:null}};
  const api=client(async(url)=>{calls.push(String(url));return Response.json(String(url).includes('evidence')?fresh:queued(saved),{status:String(url).includes('evidence')?200:202});});
  saved=updateDurableAction(s,saved,{receipt:await api.submit(saved)});
  assert.equal(saved.phase,'pending');
  saved=reconcileDurableAction(s,saved,await api.evidence(held.releaseId));
  assert.equal(saved.phase,'completed');assert.equal(saved.receipt?.published,false);
  assert.equal(releasePublicationReady(parseReleaseActionEvidence(fresh,held.releaseId)),true);
  assert.equal(calls.filter(url=>url.includes('publish')).length,0);
});

test('queued publication persists through reload and resolves only its matching durable operation receipt',async()=>{
  const s=storage(),scope=actionScope(evidence,origin),calls:string[]=[];
  let saved=prepareDurableAction(s,scope,'publish',publishCommand(evidence,id(13)));
  const api=client(async(url)=>{calls.push(String(url));return Response.json(queued(saved),{status:202});});
  saved=updateDurableAction(s,saved,{receipt:await api.submit(saved)});
  saved=readDurableAction(s,scope,'publish')!;
  const other={...evidence,publishOperation:{decisionId:id(99),status:'completed' as const,receipt:{...published(saved),decisionId:id(99)},errorCode:null}};
  assert.equal(reconcileDurableAction(s,saved,other).phase,'pending');
  const complete={...evidence,publishOperation:{decisionId:id(13),status:'completed' as const,receipt:published(saved),errorCode:null}};
  const done=reconcileDurableAction(s,saved,complete);
  assert.equal(done.phase,'completed');assert.equal(done.receipt?.publicationId,id(20));
  assert.equal(calls.length,1);
});

test('unknown publication retains exact previous-version CAS despite newer evidence',async()=>{
  const s=storage(),scope=actionScope(evidence,origin);
  const saved=prepareDurableAction(s,scope,'publish',publishCommand(evidence,id(14)));
  updateDurableAction(s,saved,{errorCode:'ACTION_OUTCOME_UNKNOWN',unknown:true});
  const newer={...evidence,currentPublicationId:id(80),currentPublicationVersion:4,reviewRevision:8};
  const retry=prepareDurableAction(s,scope,'publish',publishCommand(newer,id(15)));
  assert.equal(retry.command.decisionId,id(14));
  assert.equal((retry.command as any).expectedPreviousPublicationId,id(6));
  assert.notEqual(publicationConfirmationKey(newer),publicationConfirmationKey(evidence));
});

test('actor/origin/release storage scopes isolate receipts and actor changes prevent mutation transport',async()=>{
  const s=storage(),scope=actionScope(evidence,origin);
  const saved=prepareDurableAction(s,scope,'publish',publishCommand(evidence,id(16)));
  for(const patch of [{actorId:id(40)},{releaseId:id(41)},{organizationId:id(42)},{origin:'https://next-master-v3-staging-20261006.netlify.app'}])
    assert.equal(readDurableAction(s,{...scope,...patch},'publish'),null);
  let calls=0;
  await assert.rejects(client(async()=>{calls++;return Response.json({});},id(40)).submit(saved),/ACTION_ACTOR_CHANGED/);
  assert.equal(calls,0);
  assert.throws(()=>reconcileDurableAction(s,saved,{...evidence,actorId:id(40)}),/ACTION_ACTOR_CHANGED/);
});

test('unavailable or corrupt storage prevents a new command and never silently replaces a pending receipt',()=>{
  const s=storage(),scope=actionScope(evidence,origin);
  assert.throws(()=>prepareDurableAction({...s,setItem:()=>{throw new Error('storage unavailable');}},scope,'publish',publishCommand(evidence,id(17))),/storage unavailable/);
  const saved=prepareDurableAction(s,scope,'publish',publishCommand(evidence,id(17)));
  const key=[...s.map.keys()][0];s.map.set(key,JSON.stringify({...saved,command:{...saved.command,releaseId:id(50)}}));
  assert.throws(()=>readDurableAction(s,scope,'publish'),/ACTION_RECEIPT_STORAGE_INVALID/);
  assert.throws(()=>prepareDurableAction(s,scope,'publish',publishCommand(evidence,id(18))),/ACTION_RECEIPT_STORAGE_INVALID/);
});

test('default-closed client does no token lookup or network and server-disabled response is a known rejection',async()=>{
  let calls=0;
  const disabled=createSupplierReleaseActionsClient({enabled:()=>false,origin:()=>origin,getAuth:async()=>{calls++;throw new Error('must not run');},transport:async()=>{calls++;throw new Error('must not run');}});
  await assert.rejects(disabled.evidence(id(3)),/NOT_ENABLED/);assert.equal(calls,0);
  const s=storage(),r=prepareDurableAction(s,actionScope(evidence,origin),'publish',publishCommand(evidence,id(19)));
  await assert.rejects(client(async()=>Response.json({code:'RELEASE_ACTIONS_NOT_ENABLED'},{status:503})).submit(r),
    (error:SupplierReleaseActionError)=>error.outcome==='not_submitted');
});

test('ambiguous response body is unknown and extra server fields are excluded from stored receipts',async()=>{
  const s=storage(),r=prepareDurableAction(s,actionScope(evidence,origin),'publish',publishCommand(evidence,id(21)));
  await assert.rejects(client(async()=>new Response('not-json',{status:502})).submit(r),(e:SupplierReleaseActionError)=>e.outcome==='unknown');
  const receipt=await client(async()=>Response.json({...published(r),token:'must-not-persist',priceRows:[{buy_price:12.34}]})).submit(r);
  updateDurableAction(s,r,{receipt});
  assert.doesNotMatch([...s.map.values()].join(''),/must-not-persist|priceRows|buy_price/);
});

test('evidence cannot enable publication from validated status alone, incomplete counters, held audit, or another pending operation',()=>{
  assert.equal(releasePublicationReady(parseReleaseActionEvidence(evidence,id(3))),true);
  for(const patch of [{canPublish:false},{sourceVerified:false},{mode:'merge'},{status:'staged'},{errorCode:'VALIDATION_REVIEW_REQUIRED'},
    {acceptedRows:107},{processedRows:107},{conflictRows:1},{rejectedRows:1},{brandIdentityAudit:null},
    {brandIdentityAudit:{...evidence.brandIdentityAudit,review_required:true}},
    {reviewOperation:{decisionId:id(25),status:'running' as const,receipt:null,errorCode:null}}])assert.equal(releasePublicationReady({...evidence,...patch}),false);
  for(const patch of [{actorId:undefined},{canPublish:'true'},{acceptedRows:null},{reviewOperation:undefined},{publishOperation:undefined}])
    assert.throws(()=>parseReleaseActionEvidence({...evidence,...patch},id(3)),/ACTION_EVIDENCE_INVALID/);
});

function render(patch:Record<string,unknown>={}) {
  // Root-level tsx tests use classic JSX; the production web build uses the
  // automatic runtime for existing shared components such as Button.
  const previous=(globalThis as any).React;(globalThis as any).React=React;
  try{return renderToStaticMarkup(React.createElement(SupplierReleaseActionView,{tr:true,evidence,records:{review:null,publish:null},error:null,
    loading:false,busy:false,confirmed:false,reason:'comparison_repaired',onConfirm:()=>{},onReason:()=>{},onRefresh:()=>{},onReview:()=>{},onPublish:()=>{},onRetry:()=>{},...patch} as any));
  }finally{(globalThis as any).React=previous;}
}

test('rendered inline publication requires a separate checkbox and shows actual full scope/count/previous version',()=>{
  const html=render();
  assert.match(html,/GEBA.*Geba/);assert.match(html,/108 satırıyla değiştirilecek/);assert.match(html,/v3/);
  assert.match(html,/type="checkbox"/);assert.doesNotMatch(html,/role="dialog"/);
  const button=html.slice(html.lastIndexOf('<button'),html.lastIndexOf('</button>'));
  assert.match(button,/disabled/);
  const enabled=render({confirmed:true});assert.doesNotMatch(enabled.slice(enabled.lastIndexOf('<button')),/disabled/);
});

test('rendered stale/held/unknown cases keep publication disabled despite an earlier checkbox',()=>{
  const s=storage(),saved=prepareDurableAction(s,actionScope(evidence,origin),'publish',publishCommand(evidence,id(26)));
  const unknown=updateDurableAction(s,saved,{errorCode:'ACTION_OUTCOME_UNKNOWN',unknown:true});
  for(const patch of [{evidence:{...evidence,canPublish:false}},{error:'ACTION_EVIDENCE_STALE'},{records:{review:null,publish:unknown}}]) {
    const html=render({confirmed:true,...patch});
    const index=html.indexOf('Onayla ve yayınla');const start=html.lastIndexOf('<button',index);
    assert.match(html.slice(start,index),/disabled/);
  }
  const html=render({records:{review:null,publish:unknown}});
  assert.match(html,/Aynı işlemin sonucunu kontrol et/);assert.match(html,new RegExp(id(26)));
});
