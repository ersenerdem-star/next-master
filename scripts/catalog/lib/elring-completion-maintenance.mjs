import {setTimeout as sleep} from 'node:timers/promises';
export const indexes=['idx_catalog_products_search_text_trgm','idx_catalog_products_desc_trgm','idx_catalog_products_oem_trgm',
 'idx_catalog_products_product_code_trgm','idx_catalog_products_normalized_code_trgm','idx_catalog_products_normalized_oem_trgm'];
export async function maintainIndexes({request,health,run,onResult=async()=>{}}){
 for(const index of indexes){
  await health();let done=false;
  const pending=request('/rest/v1/rpc/maintain_elring_completion_index',{input_run_id:run,input_index:index},50000)
   .then(value=>{done=true;return{value};},error=>{done=true;return{error};});
  try{while(!done){await Promise.race([pending,sleep(750)]);if(!done)await health();}}
  catch(e){await request('/rest/v1/rpc/cancel_elring_completion_maintenance',{input_run_id:run});await pending;throw e;}
  const result=await pending;if(result.error)throw result.error;await onResult(result.value);await health();
 }
}
