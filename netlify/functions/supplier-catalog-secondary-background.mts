import type {Config} from '@netlify/functions';
import {json} from './_shared/http.mts';
import {supplierCatalogTarget,catalogEnrichmentRpc} from './_shared/catalog/supplier-enrichment-worker.mts';
import {requireSecondaryDispatch,runSupplierSecondaryReviews} from './_shared/catalog/supplier-secondary-worker.mts';
export default async(req:Request)=>{
 const target=supplierCatalogTarget(n=>Netlify.env.get(n));if(!target||req.method!=='POST')return json({error:'SECONDARY_DISABLED'},403);
 try{
  const raw=await req.text();if(raw.length>512)throw Error();const body=JSON.parse(raw);requireSecondaryDispatch(req,target.key,body.id,body.token);
  const rpc=catalogEnrichmentRpc(target);
  // Resume one already claimed receipt without granting direct private-table
  // access to service_role. The RPC returns only this fenced scope.
  const claim=await rpc('read_supplier_catalog_secondary_claim',{input_id:body.id,input_token:body.token});
  return json(await runSupplierSecondaryReviews({rpc,firstClaim:claim}));
 }catch{return json({error:'SECONDARY_REVIEW_UNCONFIRMED'},500);}
};
export const config:Config={background:true};
