import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {setTimeout as sleep} from 'node:timers/promises';
export async function withElringWriteLease(file,fn){
 const token=randomUUID(),start=Date.now();
 while(true){try{await fs.writeFile(file,JSON.stringify({pid:process.pid,token}),{flag:'wx',mode:0o600});break;}
  catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')continue;await sleep(100);continue;}
   try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')throw Error('STALE_ELRING_WRITE_LEASE_REQUIRES_VERIFIED_RECOVERY');throw e;}
   if(Date.now()-start>600000)throw Error('ELRING_WRITE_LEASE_WAIT_TIMEOUT');await sleep(150);
  }}
 try{return await fn();}finally{const owner=JSON.parse(await fs.readFile(file,'utf8'));if(owner.token!==token)throw Error('ELRING_WRITE_LEASE_OWNERSHIP');await fs.unlink(file);}
}
