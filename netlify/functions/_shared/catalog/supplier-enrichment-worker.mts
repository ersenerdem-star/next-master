import {createHmac,timingSafeEqual} from 'node:crypto';
import {supplierUpgradeServiceHeaders} from '../supplier-upgrade-auth.mts';
import {ENRICHMENT_POLICY,sourceCatalogFields,planSupplierCatalogEnrichment} from './supplier-enrichment-plan.mjs';
import {supplierOfficialProvider,safeSupplierOfficialObservation} from './supplier-official-completion.mts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function supplierCatalogTarget(read:(name:string)=>string|undefined){
 if(read('SUPPLIER_CATALOG_ENRICHMENT_ENABLED')!=='1')return null;
 const url=read('SUPABASE_URL'),key=read('SUPABASE_SERVICE_ROLE_KEY');if(!key)return null;
 if(url==='https://zjgueqijumzlfioihnkt.supabase.co'&&read('NM_PRODUCTION_TARGET')==='zjgueqijumzlfioihnkt'&&!read('NM_FULL_STAGING_TARGET'))return {url,key,portal:'https://portal.next-master.com'};
 if(url==='https://kaxsqafdevabkxofwdod.supabase.co'&&!read('NM_PRODUCTION_TARGET'))return {url,key,portal:'https://next-master-v3-staging-20261006.netlify.app'};
 throw Error('CATALOG_ENRICHMENT_TARGET_DENIED');
}
type Target={url:string;key:string;portal:string};
export function catalogEnrichmentRpc(target:Target){return async(name:string,args:Record<string,unknown>={})=>{
 const response=await fetch(`${target.url}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',headers:supplierUpgradeServiceHeaders(target.key),
  body:JSON.stringify(args),signal:AbortSignal.timeout(25000)});
 const data=await response.json().catch(()=>null);
 if(!response.ok){
  if(data?.code==='57014')throw Error('CATALOG_ENRICHMENT_DATABASE_TIMEOUT');
  if(['55P03','40001','40P01'].includes(data?.code))throw Error('CATALOG_ENRICHMENT_DATABASE_BUSY');
  throw Error(/^CATALOG_ENRICHMENT_[A-Z_]+$/.test(data?.message||'')?data.message:'CATALOG_ENRICHMENT_RPC_UNCONFIRMED');
 }
 return data;
};}
const signature=(key:string,jobId:string,token:string,timestamp:string)=>createHmac('sha256',key).update(`${ENRICHMENT_POLICY}\n${jobId}\n${token}\n${timestamp}`).digest('hex');
export function enrichmentDispatchHeaders(target:Target,jobId:string,token:string){const timestamp=String(Date.now());return {'Content-Type':'application/json','x-catalog-time':timestamp,'x-catalog-signature':signature(target.key,jobId,token,timestamp)};}
export function requireEnrichmentDispatch(req:Request,target:Target,jobId:string,token:string){
 const ts=req.headers.get('x-catalog-time')||'',value=req.headers.get('x-catalog-signature')||'';
 if(!UUID.test(jobId)||!UUID.test(token)||!/^\d{13}$/.test(ts)||Math.abs(Date.now()-Number(ts))>90000||! /^[a-f0-9]{64}$/.test(value)
  ||!timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(signature(target.key,jobId,token,ts),'hex')))throw Error('CATALOG_ENRICHMENT_DISPATCH_DENIED');
}
type Rpc=(name:string,args?:Record<string,unknown>)=>Promise<any>;
export async function runSupplierCatalogEnrichment({rpc,jobId,token,budgetMs=10*60*1000,officialProvider=supplierOfficialProvider,now=Date.now,officialDelayMs=1100,wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))}:{rpc:Rpc;jobId:string;token:string;budgetMs?:number;officialProvider?:typeof supplierOfficialProvider;now?:()=>number;officialDelayMs?:number;wait?:(ms:number)=>Promise<void>}){
 const start=now(),scope={input_job_id:jobId,input_token:token};
 try{
  while(now()-start<budgetMs){
   const batch=await rpc('read_supplier_catalog_enrichment_batch',scope);
   if(['completed','superseded'].includes(batch?.status))return {status:batch.status};
   if(batch?.status==='deferred')return {status:'continuation'};
   if(batch?.status==='next_phase')continue;
   if(batch?.status!=='batch'||!['file','official'].includes(batch.phase)||!Array.isArray(batch.rows)||!batch.rows.length)throw Error('CATALOG_ENRICHMENT_BATCH_UNCONFIRMED');
   const provider=batch.phase==='official'?officialProvider(batch.brand):null;
   const needsOfficial=batch.phase==='official'&&batch.rows.some((r:any)=>planSupplierCatalogEnrichment({existing:r.existing||{},incoming:{},phase:'official'}).missing.length>0);
   if(needsOfficial&&!provider)return await rpc('finish_supplier_catalog_without_official_source',scope);
   const buildRow=async(row:any)=>{
    let incoming=sourceCatalogFields(row.source),evidence:any={},issues:any[]=[];
    const before=row.existing||{};
    const initial=planSupplierCatalogEnrichment({existing:before,incoming:{},phase:'official'});
    if(batch.phase==='official'){
     incoming={};evidence={};
     if(initial.missing.length&&row.rowStatus==='accepted'){
      try{
       await wait(officialDelayMs);
       const observation=safeSupplierOfficialObservation(await provider!.fetch(row.code),row.code,batch.brandId);
       incoming=observation.fields;evidence={...observation.evidence,policy:ENRICHMENT_POLICY,provider:provider!.key};
      }catch(error){
       if(String((error as Error)?.message).includes('OFFICIAL_EXACT_MATCH_NOT_FOUND'))issues.push({field:'source',code:'OFFICIAL_EXACT_MATCH_NOT_FOUND'});
       else{
        const text=String((error as Error)?.message||error),code=/429|rate.limit/i.test(text)?'OFFICIAL_SOURCE_RATE_LIMIT':/401|403/.test(text)?'OFFICIAL_SOURCE_ACCESS_DENIED':/timeout|timed.out|abort/i.test(text)?'OFFICIAL_SOURCE_TIMEOUT':'OFFICIAL_SOURCE_UNAVAILABLE';
        throw Object.assign(Error(code),{sourceRow:row.rowNumber,provider:provider!.key});
       }
      }
     }
    }
    const plan=planSupplierCatalogEnrichment({existing:before,incoming,phase:batch.phase,fieldState:row.fieldState,sourceDate:batch.sourceDate,conflicts:row.conflicts});
    if(batch.phase==='file'&&(Object.keys(plan.patch).length||plan.issues.length))evidence={policy:ENRICHMENT_POLICY,authority:'supplier_file'};
    return {rowNumber:row.rowNumber,existing:before,patch:plan.patch,issues:[...issues,...plan.issues],
     missing:batch.phase==='official'&&plan.missing.length>0,missingFields:batch.phase==='official'?plan.missing:[],evidence};
   };
   if(batch.phase==='official'){
    // Commit each completed observation before the next source call. A later
    // timeout cannot discard earlier successful rows in this fetched prefix.
    let cursor=batch.cursor;
    for(const row of batch.rows){
     if(now()-start>=budgetMs){await rpc('release_supplier_catalog_enrichment',scope);return {status:'continuation'};}
     const built=await buildRow(row);
     const result=await rpc('apply_supplier_catalog_enrichment_batch',{...scope,input_phase:batch.phase,input_cursor:cursor,input_rows:[built]});
     if(result?.status==='superseded')return result;
     if(result?.status!=='applied'||result.cursor!==row.rowNumber)throw Error('CATALOG_ENRICHMENT_APPLY_UNCONFIRMED');
     cursor=result.cursor;
    }
   }else{
    const rows=await Promise.all(batch.rows.map(buildRow));
    const result=await rpc('apply_supplier_catalog_enrichment_batch',{...scope,input_phase:batch.phase,input_cursor:batch.cursor,input_rows:rows});
    if(result?.status==='superseded')return result;
    if(result?.status!=='applied')throw Error('CATALOG_ENRICHMENT_APPLY_UNCONFIRMED');
   }
  }
  await rpc('release_supplier_catalog_enrichment',scope);return {status:'continuation'};
 }catch(error){
  await rpc('release_supplier_catalog_enrichment',{...scope,input_error:String((error as Error)?.message||''),input_error_row:(error as any)?.sourceRow??null,input_error_provider:(error as any)?.provider??null}).catch(()=>{});
  throw Error(/^CATALOG_ENRICHMENT_[A-Z_]+$/.test(String((error as Error)?.message))?(error as Error).message:'CATALOG_ENRICHMENT_UNCONFIRMED');
 }
}
