import {setTimeout as sleep} from 'node:timers/promises';
export async function readOfficialRequest(request,{beforeAttempt=async()=>{},fetchImpl=fetch,wait=sleep}={}){
 for(let attempt=0;attempt<3;attempt++){
  await beforeAttempt(attempt);
  try{
   const r=await fetchImpl('https://webservice.tecalliance.services/pegasus-3-0/services/TecdocToCatDLB.jsonEndpoint',{
    method:'POST',headers:{'content-type':'application/json',origin:'https://web.tecalliance.net',referer:'https://web.tecalliance.net/elring/en/home'},
    body:JSON.stringify(request),redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!r.ok){await r.body?.cancel();throw Error(`SOURCE_HTTP_${r.status}`);}
   const chunks=[];let bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw Error('SOURCE_BYTE_LIMIT');chunks.push(chunk);}
   const response=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(response.status!==200)throw Error(`SOURCE_STATUS_${response.status}`);return response;
  }catch(e){
   const transient=['TypeError','TimeoutError','AbortError'].includes(e.name)||/^SOURCE_(HTTP|STATUS)_(429|5\d\d)$/.test(e.message);
   if(!transient||attempt===2)throw e;await wait(2000*(attempt+1));
  }
 }
}
