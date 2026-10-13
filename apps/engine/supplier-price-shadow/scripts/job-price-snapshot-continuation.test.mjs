import test from 'node:test';
import assert from 'node:assert/strict';
import {createJobPriceSnapshotReader} from '../src/export/job-price-snapshot-reader.mjs';

const jobId='11111111-1111-4111-8111-111111111111';
const brandId='22222222-2222-4222-8222-222222222222';
const organizationId='33333333-3333-4333-8333-333333333333';
const actorId='44444444-4444-4444-8444-444444444444';
const source=Array.from({length:5},(_,index)=>({
  normalized_code:`CODE${index+1}`,product_code:`CODE${index+1}`,brand:'Clevite',description:`Item ${index+1}`,
  sales_price:'12.50',price_date:'2026-10-13',lifecycle_status:'active',total_count:index===0?'5':null,
}));

function fakeDatabase(){
  const state={
    job:{id:jobId,organization_id:organizationId,requested_by:actorId,audience:'admin',export_type:'admin_price_list',
      status:'running',scope:{brandId,brandName:'Clevite',priceListType:'A',marginPercent:0.1,currency:'EUR'},
      data_version:'v1',progress_total:null,created_at:'2026-10-13T00:00:00Z',unexpired:true},
    sourceVersion:'v1',owner:'worker-1',snapshot:null,rows:[],pageReads:0,
  };
  const client={release(){},async query(sql,args=[]){
    if(/^(begin|commit|rollback|set local)/i.test(sql))return {rows:[],rowCount:0};
    if(sql.includes('from public.app_export_jobs where id=$1'))return {rows:[{...state.job}]};
    if(sql.includes('from public.brands where id=$1'))return {rows:[{id:brandId,name:'Clevite'}]};
    if(sql.includes('from public.profiles where id=$1'))return {rows:[{id:actorId,organization_id:organizationId,
      role:'admin',department:'operations',permissions:{},is_active:true,session_revoked_at:null}]};
    if(sql.includes('get_admin_price_list_export_version'))return {rows:[{version:state.sourceVersion}]};
    if(sql.includes('from export_snapshot_private.snapshots where job_id=$1'))return {rows:state.snapshot?[{...state.snapshot}]:[]};
    if(sql.includes('insert into export_snapshot_private.snapshots')){
      state.snapshot={id:args[0],job_id:args[1],status:'building',authority_digest:args[2],descriptor:null,binding:null};
      return {rows:[],rowCount:1};
    }
    if(sql.includes('last_source_key'))return {rows:[{count:String(state.rows.length),
      last_ordinal:state.rows.length?String(state.rows.at(-1).ordinal):null,
      last_source_key:state.rows.at(-1)?.source_key??null}]};
    if(sql.includes('from public.cloud_admin_price_list_page_fast')){
      state.pageReads++;
      const after=args[4];
      return {rows:source.filter(row=>after==null||row.normalized_code>after).slice(0,args[5]).map((row,index)=>({
        ...row,total_count:after==null&&index===0?'5':null,
      }))};
    }
    if(sql.includes('from public.item_code_references'))return {rows:[]};
    if(sql.includes('insert into export_snapshot_private.rows')){
      const records=JSON.parse(args[1]);
      for(const record of records){
        if(state.rows.some(row=>row.ordinal===record.ordinal))throw Error('duplicate ordinal');
        state.rows.push(record);
      }
      return {rows:[],rowCount:records.length};
    }
    if(sql.includes("update export_snapshot_private.snapshots set status='sealed'")){
      if(state.snapshot.status!=='building'||state.snapshot.authority_digest!==args[3])return {rows:[],rowCount:0};
      Object.assign(state.snapshot,{status:'sealed',descriptor:JSON.parse(args[1]),binding:args[2]});
      return {rows:[{id:state.snapshot.id}],rowCount:1};
    }
    throw Error(`Unexpected query: ${sql}`);
  }};
  const pool={options:{connectionString:'postgresql://test@127.0.0.1:5432/nm_export_reader_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',max:2},
    async connect(){return client;}};
  return {state,pool};
}

function reader({state,pool,owner,shouldYieldSnapshot=()=>false,onPageTiming=()=>{}}){
  return createJobPriceSnapshotReader({pool,mode:'local-only',pageSize:2,
    operationsAllowed:()=>true,resolvePortalContext:()=>{throw Error('unexpected portal context');},
    assertWriteLease:()=>{if(state.owner!==owner)throw Error('V3_EXPORT_LEASE_LOST');},
    checkpoint:({processed,total})=>{state.job.progress_total=total;state.job.progress_done=processed;},
    shouldYieldSnapshot,onPageTiming});
}

test('committed snapshot pages resume once under a new lease and seal at exact row count',async()=>{
  const {state,pool}=fakeDatabase();
  const first=await reader({state,pool,owner:'worker-1',shouldYieldSnapshot:()=>true}).resolveAuthorizedInput(jobId);
  assert.deepEqual({status:first.status,processed:first.processed,total:first.total},
    {status:'building',processed:2,total:5});
  assert.equal(state.snapshot.status,'building');
  assert.equal(state.rows.length,2);

  state.owner='worker-2';
  await assert.rejects(reader({state,pool,owner:'worker-1'}).resolveAuthorizedInput(jobId),/V3_EXPORT_LEASE_LOST/);
  assert.equal(state.rows.length,2);

  const second=await reader({state,pool,owner:'worker-2',shouldYieldSnapshot:()=>true}).resolveAuthorizedInput(jobId);
  assert.deepEqual({status:second.status,processed:second.processed,total:second.total},
    {status:'building',processed:4,total:5});
  state.owner='worker-3';
  const sealed=await reader({state,pool,owner:'worker-3',shouldYieldSnapshot:()=>true}).resolveAuthorizedInput(jobId);
  assert.equal(sealed.expectedRows,5);
  assert.equal(sealed.snapshotId,first.snapshotId);
  assert.equal(state.snapshot.status,'sealed');
  assert.deepEqual(state.rows.map(row=>row.ordinal),[1,2,3,4,5]);
  assert.equal(state.pageReads,3);
});

test('a changed source version blocks continuation before writing another page',async()=>{
  const {state,pool}=fakeDatabase();
  await reader({state,pool,owner:'worker-1',shouldYieldSnapshot:()=>true}).resolveAuthorizedInput(jobId);
  state.owner='worker-2';
  state.sourceVersion='v2';
  await assert.rejects(reader({state,pool,owner:'worker-2'}).resolveAuthorizedInput(jobId),/EXPORT_SNAPSHOT_SOURCE_CHANGED/);
  assert.equal(state.rows.length,2);
  assert.equal(state.snapshot.status,'building');
});

test('snapshot timing reports committed page phases without affecting the export',async()=>{
  const {state,pool}=fakeDatabase();
  const timings=[];
  const spec=await reader({state,pool,owner:'worker-1',onPageTiming:event=>{
    timings.push(event);
    throw Error('telemetry sink failed');
  }}).resolveAuthorizedInput(jobId);
  assert.equal(spec.expectedRows,5);
  assert.deepEqual(timings.map(event=>[event.pageRows,event.processed,event.total,event.checkpointOk]),
    [[2,2,5,true],[2,4,5,true],[1,5,5,true]]);
  for(const event of timings){
    for(const field of ['pricingRpcMs','replacementLookupMs','snapshotInsertMs','transactionMs','checkpointMs','pageMs']){
      assert.ok(Number.isFinite(event[field])&&event[field]>=0,field);
    }
    assert.equal('rows' in event,false);
    assert.equal('scope' in event,false);
  }
});
