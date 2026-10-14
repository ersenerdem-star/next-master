import {parseActionReceipt,parseReleaseActionEvidence,releaseActionsTargetEnabled,type DurableAction} from '../../shared/supplierReleaseActions';

export class SupplierReleaseActionError extends Error {
  constructor(public code:string,public outcome:'unknown'|'not_submitted'='not_submitted') {super(code);this.name='SupplierReleaseActionError';}
}
export function supplierReleaseActionsEnabled() {
  const env=import.meta.env||{};
  return releaseActionsTargetEnabled({enabled:env.VITE_SUPPLIER_PRICE_RELEASE_ACTIONS_ENABLED,
    productionEnabled:env.VITE_SUPPLIER_PRICE_RELEASE_ACTIONS_PRODUCTION_ENABLED,productionTarget:env.VITE_NM_PRODUCTION_TARGET,
    supabaseUrl:env.VITE_SUPABASE_URL,origin:typeof window==='undefined'?undefined:window.location.origin});
}
type ClientDependencies={
  enabled:()=>boolean; origin:()=>string;
  getAuth:()=>Promise<{token:string;actorId:string}>;
  transport?:typeof fetch;
};
const safeCode=(v:unknown,fallback:string)=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,159}$/.test(v)?v:fallback;

export function createSupplierReleaseActionsClient(deps:ClientDependencies) {
  async function request(path:string,options:{signal?:AbortSignal;action?:DurableAction}={}) {
    if(!deps.enabled())throw new SupplierReleaseActionError('RELEASE_ACTIONS_NOT_ENABLED');
    let auth:{token:string;actorId:string};
    try{auth=await deps.getAuth();}catch{throw new SupplierReleaseActionError('ACTION_AUTH_REQUIRED');}
    if(!auth.token||!auth.actorId)throw new SupplierReleaseActionError('ACTION_AUTH_REQUIRED');
    if(options.action&&(auth.actorId!==options.action.scope.actorId||deps.origin()!==options.action.scope.origin))throw new SupplierReleaseActionError('ACTION_ACTOR_CHANGED');
    if(options.signal?.aborted)throw new SupplierReleaseActionError('ACTION_CANCELLED');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),25000);
    const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});
    try {
      const response=await (deps.transport||fetch)(path,{method:options.action?'POST':'GET',redirect:'error',cache:'no-store',
        headers:{Authorization:`Bearer ${auth.token}`,...(options.action?{'Content-Type':'application/json'}:{})},
        ...(options.action?{body:JSON.stringify(options.action.command)}:{}),signal:controller.signal});
      const data:unknown=await response.json();
      const error=data&&typeof data==='object'?data as Record<string,unknown>:{};
      if(!response.ok) {
        const known=error.outcome==='not_submitted'||[401,403,404].includes(response.status)
          ||safeCode(error.code,'').includes('NOT_ENABLED');
        throw new SupplierReleaseActionError(safeCode(error.code,response.status===401?'ACTION_AUTH_REQUIRED':'ACTION_REQUEST_FAILED'),
          options.action&&!known?'unknown':'not_submitted');
      }
      return {data,actorId:auth.actorId};
    } catch(error) {
      if(error instanceof SupplierReleaseActionError)throw error;
      throw new SupplierReleaseActionError(options.action?'ACTION_OUTCOME_UNKNOWN':'ACTION_EVIDENCE_UNAVAILABLE',options.action?'unknown':'not_submitted');
    } finally {clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
  }
  return {
    async evidence(releaseId:string,signal?:AbortSignal) {
      const {data,actorId}=await request(`/api/supplier-price-release-evidence?releaseId=${encodeURIComponent(releaseId)}`,{signal});
      try {
        const evidence=parseReleaseActionEvidence(data,releaseId);
        if(evidence.actorId!==actorId)throw new Error('ACTION_ACTOR_CHANGED');
        return evidence;
      }catch{throw new SupplierReleaseActionError('ACTION_EVIDENCE_INVALID');}
    },
    async submit(action:DurableAction,signal?:AbortSignal) {
      const {data}=await request(`/api/supplier-price-release-${action.kind}`,{action,signal});
      try{
        const receipt=parseActionReceipt(data,action.scope.releaseId,action.command.decisionId);
        if(action.kind==='review'&&(receipt.status==='published'||receipt.action!==('action' in action.command?action.command.action:undefined)))throw new Error('ACTION_RECEIPT_INVALID');
        if(action.kind==='publish'&&(['rechecked_clear','rejected'].includes(receipt.status)
          ||['queued','running'].includes(receipt.status)&&receipt.action!=='publish'))throw new Error('ACTION_RECEIPT_INVALID');
        return receipt;
      }
      catch{throw new SupplierReleaseActionError('ACTION_OUTCOME_UNKNOWN','unknown');}
    },
  };
}

export const supplierReleaseActionsClient=createSupplierReleaseActionsClient({enabled:supplierReleaseActionsEnabled,
  origin:()=>window.location.origin,getAuth:async()=>{
    const {supabaseClient}=await import('./supabaseClient');
    const {data,error}=await supabaseClient.auth.getSession();
    if(error||!data.session?.access_token||!data.session.user?.id)throw new Error('ACTION_AUTH_REQUIRED');
    return {token:data.session.access_token,actorId:data.session.user.id};
  }});
