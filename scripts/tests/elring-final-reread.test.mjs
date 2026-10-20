import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {finalizeElringCompletion,acceptedSecondaryFill} from '../catalog/lib/elring-final-reread.mjs';
async function fixture(drift){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'elring-final-'));await fs.mkdir(path.join(root,'full-catalog-2026-10-19'));
 const source=[{product_code:'001',image_url:'https://official/image.jpg',replacements:[{source_relation:'replaces',old_code:'002',new_code:'001'}]},
  {product_code:'002',image_url:null,replacements:[]}];
 await fs.writeFile(path.join(root,'full-catalog-2026-10-19/products.json'),JSON.stringify({products:source}));
 for(const file of ['catalog-import-result-2026-10-19.json','catalog-completion-2026-10-20.json'])await fs.writeFile(path.join(root,file),JSON.stringify({complete:false}));
 const products=source.map((s,i)=>({id:'p'+i,product_code:s.product_code,normalized_code:s.product_code,image_url:s.image_url,description:'Seal',ean:'123',vehicle:'AUDI',vehicle_model:'AUDI A4',lifecycle_status:'active'}));
 const audits=products.map((p,i)=>({row_index:i,product_id:p.id,after_fields:{...p}}));
 if(drift)products[0].ean='changed after approved phase';
 const api=async url=>{const u=new URL(url,'https://test.invalid'),table=u.pathname.split('/').at(-1);let data;
  if(table==='catalog_elring_spareto_jobs')data=[];
  else if(table==='catalog_elring_completion_jobs')data=['images','enrichment','lifecycle','fitment'].map(phase=>({phase,status:'completed',processed:phase==='images'?1:2,organization_id:'org',brand_id:'brand'}));
  else if(table==='catalog_products')data=products;
  else if(table==='catalog_elring_completion_events')data=audits;
  else if(table==='catalog_product_relations')data=[{catalog_product_id:'p0',relation_type:'replacement',related_brand:'Elring',related_product_code:'002',source_record_id:'s1'}];
  else if(table==='catalog_product_source_records')data=[{id:'s1',catalog_product_id:'p0',source_key:'tecalliance_elring',source_version:'elring-lifecycle.v1'}];
  else throw Error('Unexpected table '+table);return{data,ms:1};};
 return{root,api,stage:source.map((s,i)=>({row_index:i,product_code:s.product_code}))};
}
test('whole-brand completion is published only after independent final field and directed-source reread',async()=>{
 const f=await fixture(false);try{
  const r=await finalizeElringCompletion({...f,run:'run',health:async()=>{}});
  assert.equal(r.verified,true);assert.equal(r.products,2);assert.equal(r.image_candidates,1);assert.equal(r.replacement_edges,1);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'catalog-completion-2026-10-20.json'),'utf8')).complete,true);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'catalog-import-result-2026-10-19.json'),'utf8')).final_canonical_reread_verified,true);
 }finally{await fs.rm(f.root,{recursive:true});}
});
test('only an audited prior-empty secondary fill with exact provenance can explain final drift',()=>{
 const p={id:'p',product_code:'001',origin:'DE'},r={id:'r',catalog_product_id:'p',source_key:'spareto_elring_product_catalog',source_version:'elring-spareto.v1',payload_fingerprint:'fp',source_url:'https://spareto.com/products/elring-gasket/001'};
 const e={product_id:'p',product_code:'001',source_record_id:'r',evidence_fingerprint:'fp',applied_fields:['origin'],before_fields:{origin:null},after_fields:{origin:'DE'},evidence:{brand:'ELRING',raw_item:{item_id:'001',item_brand:'ELRING'},source_url:r.source_url,fields:{origin:'DE'}}};
 assert.equal(acceptedSecondaryFill(e,r,p,'origin',null),true);assert.equal(acceptedSecondaryFill(e,r,p,'origin','FR'),false);
 assert.equal(acceptedSecondaryFill(e,{...r,payload_fingerprint:'tampered'},p,'origin',null),false);
 assert.equal(acceptedSecondaryFill({...e,before_fields:{origin:'FR'}},r,p,'origin',null),false);
 assert.equal(acceptedSecondaryFill(e,r,{...p,origin:'GB'},'origin',null),false);
});
test('metadata drift prevents a completed claim even when all worker cursors are complete',async()=>{
 const f=await fixture(true);try{
  await assert.rejects(finalizeElringCompletion({...f,run:'run',health:async()=>{}}),/FINAL_CANONICAL_REREAD_MISMATCH/);
  const r=JSON.parse(await fs.readFile(path.join(f.root,'final-canonical-reread-2026-10-20.json'),'utf8'));assert.equal(r.verified,false);assert.equal(r.mismatches[0].field,'ean');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'catalog-completion-2026-10-20.json'),'utf8')).complete,false);
 }finally{await fs.rm(f.root,{recursive:true});}
});
test('a running secondary job keeps overall completion false after official verification',async()=>{
 const f=await fixture(false),original=f.api;f.api=async url=>url.includes('/catalog_elring_spareto_jobs?')?{data:[{organization_id:'org',brand_id:'brand',status:'running',approval_reference:'user-elring-spareto-missing-fields-2026-10-20'}],ms:1}:url.includes('/catalog_elring_spareto_events?')?{data:[],ms:1}:original(url);
 try{await finalizeElringCompletion({...f,run:'run',health:async()=>{}});const r=JSON.parse(await fs.readFile(path.join(f.root,'catalog-completion-2026-10-20.json'),'utf8'));assert.equal(r.complete,false);assert.equal(r.official_complete,true);assert.equal(r.pending_phase,'spareto_secondary');}finally{await fs.rm(f.root,{recursive:true});}
});
