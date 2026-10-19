import type {Config} from '@netlify/functions';
import {supplierCatalogTarget,catalogEnrichmentRpc,enrichmentDispatchHeaders} from './_shared/catalog/supplier-enrichment-worker.mts';
// The scheduler only dispatches. All long-running work stays in the durable
// background consumer; an expired SQL lease is picked up by the next dispatch.
export default async()=>{
 const target=supplierCatalogTarget(name=>Netlify.env.get(name));if(!target)return;
 const rpc=catalogEnrichmentRpc(target),claim=await rpc('claim_supplier_catalog_enrichment');
 if(claim?.status!=='claimed')return;
 try{
  const response=await fetch(target.portal+'/.netlify/functions/supplier-catalog-enrichment-background',{method:'POST',redirect:'error',
   headers:enrichmentDispatchHeaders(target,claim.jobId,claim.token),body:JSON.stringify({jobId:claim.jobId,token:claim.token}),signal:AbortSignal.timeout(10000)});
  if(response.status!==202)throw Error('CATALOG_ENRICHMENT_DISPATCH_UNCONFIRMED');
 }catch{await rpc('release_supplier_catalog_enrichment',{input_job_id:claim.jobId,input_token:claim.token,input_error:'CATALOG_ENRICHMENT_DISPATCH_UNCONFIRMED'}).catch(()=>{});}
};
export const config:Config={schedule:'* * * * *'};
