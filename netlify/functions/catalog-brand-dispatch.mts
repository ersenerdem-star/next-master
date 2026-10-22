import type {Config} from '@netlify/functions';import {createClient} from '@supabase/supabase-js';
import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';
import {dispatchCatalogBrand} from './_shared/catalog/brand-dispatch-worker.mts';
export default async()=>{const target=supplierCatalogTarget(n=>Netlify.env.get(n));if(!target)return new Response(null,{status:204});
 const db=createClient(target.url,target.key,{auth:{persistSession:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(12000)})}});
 try{await dispatchCatalogBrand({db,target});}catch(error){console.error(error instanceof Error?error.message:'BRAND_DISPATCH_FAILED');}
 return new Response(null,{status:204});};
export const config:Config={schedule:'* * * * *'};
