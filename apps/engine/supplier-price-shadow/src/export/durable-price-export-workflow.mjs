// C2b factory only. No import-time launch or application/production activation.
import {mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {exportSpec,exportBinding,preparePriceExport,assemblePriceExport} from './partitioned-price-export.mjs';

export const PRICE_EXPORT_QUEUE='price-export-verified-v1';
export const PRICE_EXPORT_WORKFLOW='price-export-shared-ready-v1';
// Bounded retry for transport/rate-limit/server failures only. Authorization,
// checksum, scope and immutable conflicts require attention, never blind retry.
export const exportStepRetry=Object.freeze({retriesAllowed:true,maxAttempts:3,intervalSeconds:1,backoffRate:2,
  shouldRetry:error=>/^EXPORT_(?:(?:STORAGE|ARTIFACT)_(REQUEST_(TIMEOUT|FAILED)|(?:READ|WRITE|BUCKET)_HTTP_(429|5\d\d))|TUS_(REQUEST_(TIMEOUT|FAILED)|HTTP_(408|429|5\d\d)))$/.test(error?.message??'')});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function priceExportWorkflowId(jobId,binding){
  if(!uuid.test(jobId)||!/^[0-9a-f]{64}$/.test(binding))throw Error('EXPORT_WORKFLOW_ID_INVALID');
  return `price-export:v1:${jobId}:${binding}`;
}
export function createDurablePriceExportWorkflow({DBOS,resolveAuthorizedInput,createStores,fetchPage,progress=()=>{},faultCheckpoint=()=>{}}){
  for(const value of [resolveAuthorizedInput,createStores,fetchPage,progress,faultCheckpoint])if(typeof value!=='function')throw Error('EXPORT_WORKFLOW_CONFIG');
  return async function durablePriceExport({jobId,binding}){
    if(DBOS.workflowID!==priceExportWorkflowId(jobId,binding))throw Error('EXPORT_WORKFLOW_ID_MISMATCH');
    // Resolve from server-side job/snapshot authority; never trust browser scope.
    const input=await DBOS.runStep(async()=>{
      const {schema,...input}=exportSpec(await resolveAuthorizedInput(jobId));
      if(exportBinding(input)!==binding)throw Error('EXPORT_AUTHORIZED_BINDING_MISMATCH');
      return input;
    },{name:'authorized-export-descriptor-v1'});
    const prepared=await DBOS.runStep(async()=>{
      const stores=await createStores(input);
      if(stores.parts.binding!==binding||stores.artifact.binding!==binding)throw Error('EXPORT_STORE_BINDING_MISMATCH');
      const directory=await mkdtemp(join(tmpdir(),'nm-price-export-prepare-'));
      const result=await preparePriceExport({input,directory,partsStore:stores.parts,fetchPage,
        progress:event=>progress({jobId,stage:'preparing',...event})});
      return {binding,rows:result.manifest.rows,parts:result.manifest.parts.length};
    },{...exportStepRetry,name:'prepare-shared-price-export-v1'});
    if(prepared.binding!==binding||prepared.rows!==input.expectedRows)throw Error('EXPORT_PREPARED_METADATA_MISMATCH');
    // One step owns assembly + final commit: no durable transient file paths.
    return DBOS.runStep(async()=>{
      const stores=await createStores(input);
      if(stores.parts.binding!==binding||stores.artifact.binding!==binding)throw Error('EXPORT_STORE_BINDING_MISMATCH');
      const existing=await stores.artifact.resumeUploaded();if(existing)return existing;
      const directory=await mkdtemp(join(tmpdir(),'nm-price-export-assemble-'));
      const receipt=await assemblePriceExport({input,directory,partsStore:stores.parts,
        // The core's local ZIP-ready event is NOT downloadable shared readiness.
        progress:event=>progress({...event,jobId,stage:event.stage==='ready'?'verifying-file':'assembling'}),
        afterPartition:event=>faultCheckpoint('during-assembly',event)});
      const ready=await stores.artifact.commit({file:join(directory,receipt.file),receipt,
        afterTransfer:(stage,value)=>faultCheckpoint(stage,value),progress:event=>progress({...event,jobId}),
        afterFile:value=>faultCheckpoint('after-file',value),
        afterReady:value=>faultCheckpoint('after-ready',value)});
      await progress({jobId,stage:'ready',processedRows:ready.rows,totalRows:ready.rows,percent:100});
      return ready;
    },{...exportStepRetry,name:'assemble-and-commit-shared-price-export-v1'});
  };
}
