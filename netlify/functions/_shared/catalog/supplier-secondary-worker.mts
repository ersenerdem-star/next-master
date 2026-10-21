import {createHmac,timingSafeEqual} from 'node:crypto';
import {fetchExactSparetoSecondary} from './spareto-secondary-provider.mjs';
import {planSparetoMissingCompletion} from './catalog-completion-review.mjs';
const signature=(key:string,id:string,token:string,time:string)=>createHmac('sha256',key).update(`supplier-secondary-review-v1\n${id}\n${token}\n${time}`).digest('hex');
export function secondaryDispatchHeaders(key:string,id:string,token:string){const time=String(Date.now());return {'content-type':'application/json','x-secondary-time':time,'x-secondary-signature':signature(key,id,token,time)};}
export function requireSecondaryDispatch(req:Request,key:string,id:string,token:string){
 const time=req.headers.get('x-secondary-time')||'',value=req.headers.get('x-secondary-signature')||'';
 if(!/^[a-f0-9-]{36}$/i.test(id)||!/^[a-f0-9-]{36}$/i.test(token)||!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>90000||!/^[a-f0-9]{64}$/.test(value)||!timingSafeEqual(Buffer.from(value,'hex'),Buffer.from(signature(key,id,token,time),'hex')))throw Error('SECONDARY_DISPATCH_DENIED');
}
export async function runSupplierSecondaryReviews({rpc,firstClaim,fetchSecondary=fetchExactSparetoSecondary,budgetMs=4*60*1000,now=Date.now}:any){
 const started=now();let claim=firstClaim,processed=0;
 while(claim){
  if(!claim.skipped){
   const scope={input_id:claim.id,input_token:claim.token};
   try{
    const observation=await fetchSecondary({brand:claim.brand,code:claim.code,expectedEan:claim.official?.fields?.ean||claim.before?.ean||null});
    const proposal=planSparetoMissingCompletion({brand:claim.brand,code:claim.code,existing:claim.before,official:claim.official,secondary:observation});
    const receipt=await rpc('finish_supplier_catalog_secondary_review',{...scope,input_observation:observation,input_proposal:proposal});
    if(receipt?.status==='reviewed')await rpc('apply_supplier_catalog_secondary_approved',{input_id:claim.id});
   }catch(e:any){
    const message=String(e?.message||'');
    const code=/abort|timeout/i.test(message)?'SPARETO_TIMEOUT':/fetch failed|network|ECONN/i.test(message)?'SPARETO_NETWORK':/^[A-Z][A-Z0-9_]{1,99}$/.test(message)?message:'SECONDARY_SOURCE_FAILED';
    // An uncertain checkpoint response keeps its fenced lease. A new caller
    // cannot replace a sealed receipt because the finish RPC is single-use.
    await rpc('finish_supplier_catalog_secondary_review',{...scope,input_error:code,input_observation:e?.evidence??null}).catch(()=>{});
   }
   processed++;
  }
  // Never claim a row that this invocation will not process before yielding.
  if(now()-started>=budgetMs)break;
  claim=await rpc('claim_supplier_catalog_secondary_review',{});
 }
 return {processed,reviewOnly:true};
}
