import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';
import {dispatchZfLifecycle} from './_shared/catalog/zf-dispatch.mts';

export default async()=>{
 const target=supplierCatalogTarget(name=>Netlify.env.get(name)??process.env[name]);
 if(!target)return new Response(null,{status:204});
 const db=createClient(target.url,target.key,{auth:{persistSession:false},
  global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(12000)})}});
 try{console.info(JSON.stringify({event:'ZF_LIFECYCLE_DISPATCH',...await dispatchZfLifecycle({db,target})}));}
 catch(error){console.error(error instanceof Error?error.message:'ZF_DISPATCH_FAILED');}
 return new Response(null,{status:204});
};
export const config:Config={schedule:'* * * * *'};
