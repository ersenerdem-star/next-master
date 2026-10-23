import type {Config} from '@netlify/functions';import {createClient} from '@supabase/supabase-js';
import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';
import {dispatchCatalogBrand} from './_shared/catalog/brand-dispatch-worker.mts';
export default async()=>{const read=(n:string)=>Netlify.env.get(n)??process.env[n];const target=supplierCatalogTarget(read);if(!target){console.warn('BRAND_DISPATCH_DISABLED',{enabled:read('SUPPLIER_CATALOG_ENRICHMENT_ENABLED')==='1',keyPresent:Boolean(read('SUPABASE_SERVICE_ROLE_KEY'))});return new Response(null,{status:204});}
 const db=createClient(target.url,target.key,{auth:{persistSession:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(12000)})}});
 try{console.info(JSON.stringify({event:'BRAND_DISPATCH_RESULT',...await dispatchCatalogBrand({db,target})}));}catch(error){console.error(error instanceof Error?error.message:'BRAND_DISPATCH_FAILED');}
 return new Response(null,{status:204});};
export const config:Config={schedule:'* * * * *'};
