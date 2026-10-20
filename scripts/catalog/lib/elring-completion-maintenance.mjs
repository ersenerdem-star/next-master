import {setTimeout as sleep} from 'node:timers/promises';
export const indexes=['idx_catalog_products_search_text_trgm','idx_catalog_products_desc_trgm','idx_catalog_products_oem_trgm',
 'idx_catalog_products_product_code_trgm','idx_catalog_products_normalized_code_trgm','idx_catalog_products_normalized_oem_trgm'];
export async function maintainIndexes({request,health,run,onResult=async()=>{},wait=sleep}){
 for(const index of indexes){
  for(let attempt=0;attempt<2;attempt++){
  await health();let done=false;
  const pending=request('/rest/v1/rpc/maintain_elring_completion_index',{input_run_id:run,input_index:index},50000)
   .then(value=>{done=true;return{value};},error=>{done=true;return{error};});
  try{while(!done){await Promise.race([pending,wait(750)]);if(!done)await health();}}
  catch(e){await request('/rest/v1/rpc/cancel_elring_completion_maintenance',{input_run_id:run});await pending;throw e;}
  const result=await pending;
  if(result.error){
   // A contended maintenance lock advances no Product cursor. Permit one
   // bounded cleanup retry after a fresh health check, never a write replay.
   if(attempt===0&&/55P03/.test(result.error.message)){await wait(1000);await health();continue;}
   throw result.error;
  }
  await onResult(result.value);await health();break;
  }
 }
}
