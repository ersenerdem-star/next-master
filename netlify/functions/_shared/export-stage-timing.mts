// Advisory process measurements; never row data, pricing scope, tokens or errors.
// CPU/RSS are process-wide (concurrent invocations may overlap); RSS is a sample,
// not a claimed per-stage peak. The provider's REPORT remains the peak authority.
import {performance} from 'node:perf_hooks';
const stages=new Set(['authorized-snapshot','duckdb-materialize','prepare-partitions','assemble-xlsx','commit-artifact']);
export function createExportStageTiming(jobId:string,workerRunId:string,log=(value:unknown)=>console.info('V3_EXPORT_STAGE_TIMING',JSON.stringify(value))){
 return async function measure<T>(stage:string,run:()=>Promise<T>):Promise<T>{
  if(!stages.has(stage))throw Error('EXPORT_TIMING_STAGE_INVALID');
  const started=performance.now(),cpu=process.cpuUsage();let ok=false;
  try{const result=await run();ok=true;return result;}
  finally{
   const used=process.cpuUsage(cpu),memory=Number(process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE);
   try{log({jobId,workerRunId,stage,ok,durationMs:Math.round(performance.now()-started),
    processCpuMs:Math.round((used.user+used.system)/1000),rssMiB:Math.round(process.memoryUsage().rss/1048576),
    memoryLimitMiB:Number.isSafeInteger(memory)&&memory>0?memory:null,region:process.env.AWS_REGION||null});}
   catch{/* Telemetry cannot change a fenced business result. */}
  }
 };
}
