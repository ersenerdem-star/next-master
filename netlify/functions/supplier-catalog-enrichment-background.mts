import type {Config} from '@netlify/functions';
import {json} from './_shared/http.mts';
import {supplierCatalogTarget,catalogEnrichmentRpc,requireEnrichmentDispatch,runSupplierCatalogEnrichment} from './_shared/catalog/supplier-enrichment-worker.mts';
export default async(req:Request)=>{
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const target=supplierCatalogTarget(name=>Netlify.env.get(name));if(!target)return json({error:'CATALOG_ENRICHMENT_DISABLED'},503);
 try{
  const raw=await req.text();if(raw.length>512)return json({error:'Invalid request'},400);
  const body=JSON.parse(raw);requireEnrichmentDispatch(req,target,body.jobId,body.token);
  const result=await runSupplierCatalogEnrichment({rpc:catalogEnrichmentRpc(target),jobId:body.jobId,token:body.token});
  return json(result,200);
 }catch{console.error(JSON.stringify({stage:'catalog-enrichment',errorCode:'CATALOG_ENRICHMENT_UNCONFIRMED'}));return json({error:'CATALOG_ENRICHMENT_UNCONFIRMED'},500);}
};
export const config:Config={background:true};
