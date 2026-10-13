// v4 durable step order: preparation BEFORE a SQL lease, integrity AFTER staging.
import {createVerifiedReleaseWorkflow} from './verified-release-workflow.mjs';
import {requirePublishableSupplierPriceValidation} from './supplier-price-validation-gate.mjs';
export function createPartitionedVerifiedWorkflow({DBOS,rpc,source,requireMode,batchSize,leaseSeconds=120}){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>10000||!Number.isInteger(leaseSeconds)
  ||leaseSeconds<30||leaseSeconds>3600||typeof source?.prepare!=='function'||typeof source?.scan!=='function')throw Error('VERIFIED_WORKFLOW_CONFIG');
 // Each invocation owns its closure; a shared mutable receipt would cross jobs.
 return async input=>{
  requireMode();
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!uuid.test(input?.releaseId||'')||!uuid.test(input?.handoffId||''))throw Error('VERIFIED_WORKFLOW_INPUT');
  const release=await DBOS.runStep(()=>rpc('get_supplier_price_verified_manifest',{
   input_release_id:input.releaseId,input_handoff_id:input.handoffId}),{name:'partition-source-manifest-v3'});
  if(release?.id!==input.releaseId||release.handoff_id!==input.handoffId)throw Error('VERIFIED_MANIFEST_IDENTITY');
  const receipt=await DBOS.runStep(()=>source.prepare({release,batchSize}),{name:'shared-source-prepare-v4'});
  const validation=requirePublishableSupplierPriceValidation(receipt?.validation,release.total_rows);
  const run=createVerifiedReleaseWorkflow({DBOS,rpc,requireMode,batchSize,leaseSeconds,
   scanSource:({release,claim})=>source.scan({release,claim,batchSize,receipt})});
  const staged=await run(input);
  if(staged?.status!=='staged')throw Error('VERIFIED_STAGING_UNCONFIRMED');
  // This durable final step may replay safely. The SQL function refuses to
  // advance a release unless every staged row actually exists and is valid.
  const completed=await DBOS.runStep(()=>rpc('complete_supplier_price_release_duckdb_validation',{
   input_release_id:input.releaseId,input_total_rows:validation.totalRows,
   input_accepted_rows:validation.totalRows,input_rejected_rows:0,input_warning_rows:0,
   input_conflict_rows:0,input_missing_price_rows:0,input_duplicate_rows:0,
   input_currency_count:validation.currencyCount}),{name:'verified-duckdb-completion-v4'});
  const row=Array.isArray(completed)?completed[0]:completed;
  if(row?.status!=='validated'||row.release_id!==input.releaseId)
   throw Error('VERIFIED_VALIDATION_COMPLETION_UNCONFIRMED');
  return {status:'validated',releaseId:input.releaseId,handoffId:input.handoffId,
   publishable:row.publishable===true,published:false};
 };
}
