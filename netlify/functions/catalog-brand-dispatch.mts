import type {Config} from '@netlify/functions';import {createClient} from '@supabase/supabase-js';
import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';import {brandDispatchSignature} from './_shared/catalog/brand-dispatch.mts';
export default async()=>{const target=supplierCatalogTarget(n=>Netlify.env.get(n));if(!target)return new Response(null,{status:204});
 const db=createClient(target.url,target.key,{auth:{persistSession:false}}),now=new Date().toISOString();
 const q=await db.from('catalog_brand_jobs').select('id,organization_id,status').or(`status.eq.queued,and(status.eq.running,lease_expires_at.lt.${now}),and(status.eq.paused,or(retry_after.is.null,retry_after.lte.${now}))`).order('updated_at').limit(1);
 if(q.error||!q.data?.[0])return new Response(null,{status:204});const job=q.data[0];
 if(job.status==='paused'){const r=await db.rpc('schedule_catalog_brand_job',{input_org:job.organization_id,input_job:job.id,input_publish:false});if(r.error)return new Response(null,{status:204});}
 const t=String(Date.now());await fetch(target.portal+'/api/catalog-brand-worker-background',{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-catalog-time':t,'x-catalog-signature':brandDispatchSignature(target.key,job.id,job.organization_id,t)},body:JSON.stringify({jobId:job.id,organizationId:job.organization_id}),signal:AbortSignal.timeout(8000)}).catch(()=>{});
 return new Response(null,{status:204});};
export const config:Config={schedule:'* * * * *'};
