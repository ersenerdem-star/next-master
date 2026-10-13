// v3 durable step order: preparation BEFORE claiming a SQL batch lease.
import {createVerifiedReleaseWorkflow} from './verified-release-workflow.mjs';
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
  const receipt=await DBOS.runStep(()=>source.prepare({release,batchSize}),{name:'shared-source-prepare-v3'});
  const run=createVerifiedReleaseWorkflow({DBOS,rpc,requireMode,batchSize,leaseSeconds,
   scanSource:({release,claim})=>source.scan({release,claim,batchSize,receipt})});
  return run(input);
 };
}
