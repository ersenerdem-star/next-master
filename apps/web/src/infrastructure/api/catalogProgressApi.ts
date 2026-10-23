import {supabaseClient} from './supabaseClient';
export type CatalogProgressRow={id:string;brand:string;kind:string;source:string;phase:string;status:string;processed:number|null;total:number|null;changed:number|null;updatedAt:string|null;activeJobs:number};
export type CatalogProgress={rows:CatalogProgressRow[];checkedAt:string;truncated:boolean};
export async function fetchCatalogProgress(signal:AbortSignal):Promise<CatalogProgress>{
 let {data,error}=await supabaseClient.auth.getSession();
 if(data.session?.expires_at&&data.session.expires_at*1000<Date.now()+30000){const refreshed=await supabaseClient.auth.refreshSession();data=refreshed.data;error=refreshed.error;}
 if(error||!data.session?.access_token)throw Error('AUTH_REQUIRED');
 const response=await fetch('/api/catalog-operations-progress',{headers:{authorization:`Bearer ${data.session.access_token}`},cache:'no-store',signal});
 if(!response.ok)throw Error('CATALOG_PROGRESS_UNAVAILABLE');
 return response.json();
}
