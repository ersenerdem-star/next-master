import test from 'node:test';import assert from 'node:assert/strict';import {prewarmPreparedAdminExportFile} from '../../netlify/functions/_shared/prepared-price-prewarm.mts';
for(const type of ['catalog_master','supplier_price_list'] as const)test(`admin prewarm preserves ${type} filters and dispatches its queued artifact`,async()=>{
 const old=globalThis.fetch;const calls:string[]=[],dispatched:string[]=[],finished:any[]=[];const scope={brandId:'brand',brandName:'Bosch',supplierId:'supplier',search:'P550428',scope:'priced',marginA:.1,marginB:.15,freshness:'fresh'};
 globalThis.fetch=async(input:any,init:any={})=>{const u=new URL(String(input));calls.push(u.pathname);let data:any;
  if(u.pathname.endsWith('/claim_prepared_admin_export_profile'))data=[{id:'profile',organization_id:'org',seed_job_id:'seed',export_type:type,revision:3,lease_token:'lease'}];
  else if(u.pathname.endsWith('/finish_prepared_admin_export_profile')){finished.push(JSON.parse(init.body));data=true}
  else if(u.pathname.endsWith('/get_catalog_master_export_version')||u.pathname.endsWith('/get_supplier_price_export_version'))data='version';
  else if(u.pathname.endsWith('/profiles'))data=[{id:'actor',role:'superadmin',department:'',permissions:{},is_active:true}];
  else if(u.pathname.endsWith('/brands'))data=[{id:'brand',name:'Bosch'}];
  else if(u.pathname.endsWith('/suppliers'))data=[{id:'supplier',name:'Supplier'}];
  else if(u.pathname.endsWith('/app_export_jobs')&&u.searchParams.has('id'))data=[{id:'seed',organization_id:'org',requested_by:'actor',audience:'admin',export_type:type,scope}];
  else if(u.pathname.endsWith('/app_export_jobs')&&u.searchParams.get('status')==='in.(queued,running)')data=[{id:'queued',status:'queued',scope}];
  else throw Error('Unexpected '+u.pathname);
  return Response.json(data);
 };
 try{const result=await prewarmPreparedAdminExportFile('https://example.invalid','test-key',async id=>{dispatched.push(id)});assert.equal(result.prepared,1);assert.deepEqual(dispatched,['queued']);assert.deepEqual(finished,[{input_id:'profile',input_lease_token:'lease',input_revision:3,input_error_code:null}]);assert(calls.some(x=>x.endsWith(type==='catalog_master'?'get_catalog_master_export_version':'get_supplier_price_export_version')))}finally{globalThis.fetch=old}
});
