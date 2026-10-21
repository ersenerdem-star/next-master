import type {Config} from '@netlify/functions';
import {supplierCatalogTarget,catalogEnrichmentRpc} from './_shared/catalog/supplier-enrichment-worker.mts';
import {secondaryDispatchHeaders} from './_shared/catalog/supplier-secondary-worker.mts';
export default async()=>{
 const target=supplierCatalogTarget(n=>Netlify.env.get(n));if(!target)return new Response(null,{status:204});
 const rpc=catalogEnrichmentRpc(target);
 await rpc('apply_supplier_catalog_secondary_approved',{});
 const claim=await rpc('claim_supplier_catalog_secondary_review');if(!claim||claim.skipped)return new Response(null,{status:204});
 try{
  const r=await fetch(target.portal+'/.netlify/functions/supplier-catalog-secondary-background',{method:'POST',redirect:'error',headers:secondaryDispatchHeaders(target.key,claim.id,claim.token),body:JSON.stringify({id:claim.id,token:claim.token}),signal:AbortSignal.timeout(10000)});
  if(r.status!==202)throw Error('SECONDARY_DISPATCH_FAILED');
 }catch{await rpc('finish_supplier_catalog_secondary_review',{input_id:claim.id,input_token:claim.token,input_error:'SPARETO_NETWORK'}).catch(()=>{});}
 return new Response(null,{status:204});
};
export const config:Config={schedule:'* * * * *'};
