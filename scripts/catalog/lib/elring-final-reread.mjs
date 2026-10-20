import fs from 'node:fs/promises';
import path from 'node:path';
const scalar=['description','weight_kg','origin','hs_code','ean','oem_no','dimensions','market_segment'];
const key=s=>String(s).replace(/[^a-z0-9]/gi,'').toUpperCase();
const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
const equal=(a,b)=>JSON.stringify(sort(a??null))===JSON.stringify(sort(b??null));
const empty=v=>v==null||(typeof v==='string'&&v.trim()==='');
export function acceptedSecondaryFill(event,record,product,field,base){
 return empty(base)&&event?.phase!=='tariff'&&event?.product_id===product.id&&event.product_code===product.product_code
  &&event.evidence?.brand==='ELRING'&&key(event.evidence?.raw_item?.item_id||'')===key(product.product_code)
  &&event.evidence?.raw_item?.item_brand==='ELRING'
  &&event.evidence?.source_url===record?.source_url
  &&record?.source_key==='spareto_elring_product_catalog'&&record.source_version==='elring-spareto.v1'
  &&record.catalog_product_id===product.id&&record.id===event.source_record_id
  &&record.payload_fingerprint===event.evidence_fingerprint
  &&event.applied_fields?.includes(field)&&empty(event.before_fields?.[field])
  &&equal(product[field],event.after_fields?.[field])&&equal(product[field],event.evidence.fields?.[field]);
}
export function acceptedCustomsCorrection(event,record,product,field,base,job){
 return field==='hs_code'&&event?.phase==='tariff'&&job?.tariff_approval_reference==='user-elring-all-customs-code-authority-2026-10-20'
  &&event.product_id===product.id&&event.product_code===product.product_code
  &&event.evidence?.brand==='ELRING'&&event.evidence.raw_item?.item_brand==='ELRING'
  &&key(event.evidence.raw_item?.item_id||'')===key(product.product_code)
  &&record?.id===event.source_record_id&&record.catalog_product_id===product.id
  &&record.source_key==='spareto_elring_product_catalog'&&record.source_version==='elring-spareto.v1'
  &&record.source_url===event.evidence.source_url&&record.payload_fingerprint===event.evidence_fingerprint
  &&event.applied_fields?.includes(field)&&equal(base,event.before_fields?.hs_code)
  &&/^\d{6,12}$/.test(product.hs_code||'')&&product.hs_code===event.evidence.raw_properties?.['Customs Code']
  &&product.hs_code===event.evidence.fields?.hs_code&&product.hs_code===event.after_fields?.hs_code;
}
export async function finalizeElringCompletion({api,health,root,run,stage}){
 const read=async(table,params)=>(await api('/rest/v1/'+table+'?'+new URLSearchParams(params))).data;
 const jobs=await read('catalog_elring_completion_jobs',{run_id:'eq.'+run,select:'*'});
 if(jobs.length!==4||jobs.some(j=>j.status!=='completed')||jobs.some(j=>j.phase!=='images'&&j.processed!==stage.length))throw Error('COMPLETION_PHASES_NOT_VERIFIED');
 const source=JSON.parse(await fs.readFile(path.join(root,'full-catalog-2026-10-19/products.json'),'utf8')).products;
 const sourceByCode=new Map(source.map(s=>[key(s.product_code),s]));
 const organization=jobs[0].organization_id,brand=jobs[0].brand_id,canonical=[],mismatches=[];
 const secondaryJobs=await read('catalog_elring_spareto_jobs',{run_id:'eq.'+run,select:'*'});
 const secondaryJob=secondaryJobs[0];
 if(secondaryJobs.length>1||(secondaryJob&&(secondaryJob.organization_id!==organization||secondaryJob.brand_id!==brand
  ||secondaryJob.approval_reference!=='user-elring-spareto-missing-fields-2026-10-20')))throw Error('SECONDARY_APPROVAL_SCOPE_MISMATCH');
 let images=0,checked=0;
 for(let start=0;start<stage.length;start+=100){
  const rows=stage.slice(start,start+100);
  const products=await read('catalog_products',{organization_id:'eq.'+organization,brand_id:'eq.'+brand,
   normalized_code:'in.('+rows.map(s=>key(s.product_code)).join(',')+')',
   select:['id','normalized_code','product_code','image_url','vehicle','vehicle_model','lifecycle_status','lifecycle_note',...scalar].join(',')});
  const audits={};
  for(const phase of ['enrichment','lifecycle','fitment'])audits[phase]=await read('catalog_elring_completion_events',{
   run_id:'eq.'+run,phase:'eq.'+phase,row_index:'gte.'+start,order:'row_index',limit:rows.length,select:'row_index,product_id,after_fields'});
  if(products.length!==rows.length||Object.values(audits).some(a=>a.length!==rows.length))throw Error('FINAL_REREAD_CARDINALITY');
  const secondary=secondaryJob?await read('catalog_elring_spareto_events',{run_id:'eq.'+run,
   and:`(row_index.gte.${start},row_index.lt.${start+rows.length})`,order:'row_index,phase',limit:rows.length*3,select:'*'}):[];
  const secondaryIds=[...new Set(secondary.map(e=>e.source_record_id).filter(Boolean))],secondaryRecords=[];
  for(let i=0;i<secondaryIds.length;i+=75)secondaryRecords.push(...await read('catalog_product_source_records',{
   organization_id:'eq.'+organization,id:'in.('+secondaryIds.slice(i,i+75).join(',')+')',select:'id,catalog_product_id,source_key,source_url,source_version,payload_fingerprint'}));
  for(const row of rows){
   const p=products.find(p=>p.normalized_code===key(row.product_code)),s=sourceByCode.get(key(row.product_code));
   if(!p||!s)throw Error('FINAL_REREAD_IDENTITY');
   for(const phase of ['enrichment','lifecycle','fitment']){
    const audit=audits[phase].find(a=>a.row_index===row.row_index&&a.product_id===p.id);
    if(!audit)throw Error('FINAL_REREAD_AUDIT_IDENTITY');
    const fields=phase==='enrichment'?scalar:phase==='lifecycle'?['lifecycle_status','lifecycle_note']:['vehicle','vehicle_model'];
    for(const field of fields)if(!equal(p[field],audit.after_fields[field])&&!secondary.some(e=>{
     const record=secondaryRecords.find(r=>r.id===e.source_record_id);
     return acceptedSecondaryFill(e,record,p,field,audit.after_fields[field])||acceptedCustomsCorrection(e,record,p,field,audit.after_fields[field],secondaryJob);
    }))mismatches.push({product_code:p.product_code,phase,field});
   }
   for(const e of secondary.filter(e=>e.product_id===p.id))for(const field of e.applied_fields){
    const record=secondaryRecords.find(r=>r.id===e.source_record_id);
    if(!acceptedSecondaryFill(e,record,p,field,null)&&!acceptedCustomsCorrection(e,record,p,field,e.before_fields?.[field],secondaryJob))mismatches.push({product_code:p.product_code,phase:'secondary',field});
   }
   if(s.image_url){images++;if(p.image_url!==s.image_url)mismatches.push({product_code:p.product_code,field:'image_url'});}
   checked++;canonical.push(p);
  }
  await health();
 }
 // Directional source relations are independently checked again at completion.
 const withEdges=source.filter(s=>s.replacements?.length),edgeProducts=withEdges.map(s=>canonical.find(p=>p.normalized_code===key(s.product_code)));
 const relations=[];
 for(let i=0;i<edgeProducts.length;i+=75)relations.push(...await read('catalog_product_relations',{
  organization_id:'eq.'+organization,catalog_product_id:'in.('+edgeProducts.slice(i,i+75).map(p=>p.id).join(',')+')',relation_type:'in.(replacement,replaced_by)',
  select:'catalog_product_id,relation_type,related_brand,related_product_code,source_record_id'}));
 const sourceIds=[...new Set(relations.map(r=>r.source_record_id).filter(Boolean))],records=[];
 for(let i=0;i<sourceIds.length;i+=75)records.push(...await read('catalog_product_source_records',{
  organization_id:'eq.'+organization,id:'in.('+sourceIds.slice(i,i+75).join(',')+')',select:'id,catalog_product_id,source_key,source_version'}));
 let edges=0;
 for(const s of withEdges){const p=canonical.find(p=>p.normalized_code===key(s.product_code));for(const e of s.replacements){
  edges++;const type=e.source_relation==='replaces'?'replacement':'replaced_by',target=e.source_relation==='replaces'?e.old_code:e.new_code;
  if(!relations.some(r=>r.catalog_product_id===p.id&&r.relation_type===type&&r.related_brand?.toUpperCase()==='ELRING'&&key(r.related_product_code)===key(target)
   &&records.some(sr=>sr.id===r.source_record_id&&sr.catalog_product_id===p.id&&sr.source_key==='tecalliance_elring'&&sr.source_version==='elring-lifecycle.v1')))
   mismatches.push({product_code:p.product_code,field:'replacement',type,target});
 }}
 const report={checked_at:new Date().toISOString(),products:checked,image_candidates:images,replacement_edges:edges,mismatches,verified:mismatches.length===0};
 const write=async(file,data)=>{const p=path.join(root,file);await fs.writeFile(p+'.tmp',JSON.stringify(data,null,2));await fs.rename(p+'.tmp',p);};
 await write('final-canonical-reread-2026-10-20.json',report);
 if(mismatches.length)throw Error('FINAL_CANONICAL_REREAD_MISMATCH');
 const resultPath='catalog-import-result-2026-10-19.json',result=JSON.parse(await fs.readFile(path.join(root,resultPath),'utf8'));
 result.fitment_status='completed_vehicle_makes_models_reread_verified';result.fitment_processed_products=checked;result.vehicle_reread_verified=true;
 result.final_canonical_reread_verified=true;result.completion_checked_at=report.checked_at;await write(resultPath,result);
 const completion=JSON.parse(await fs.readFile(path.join(root,'catalog-completion-2026-10-20.json'),'utf8'));
 const complete=!secondaryJob||secondaryJob.status==='completed';
 Object.assign(completion,{complete,official_complete:true,checked_at:report.checked_at,jobs,secondary_job:secondaryJob||null,pending_phase:complete?null:'spareto_secondary',completed_phases:['images','enrichment','lifecycle','fitment'],final_reread:report});
 await write('catalog-completion-2026-10-20.json',completion);await write('completion-progress-2026-10-20.json',{status:complete?'completed':'spareto_secondary_running',complete,checked_at:report.checked_at,jobs,secondary_job:secondaryJob||null,final_reread:report});
 return report;
}
