import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {withElringWriteLease} from '../catalog/lib/elring-write-lease.mjs';
test('independent canonical writers serialize and a failed operation releases its lease',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'elring-lease-')),file=path.join(dir,'lock'),order=[];let entered,release;
 const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
 try{const a=withElringWriteLease(file,async()=>{order.push('a');entered();await wait;throw Error('guard stop');});await ready;
 const b=withElringWriteLease(file,async()=>{order.push('b');return 2;});assert.deepEqual(order,['a']);release();await assert.rejects(a,/guard stop/);assert.equal(await b,2);assert.deepEqual(order,['a','b']);await assert.rejects(fs.stat(file),{code:'ENOENT'});
 await fs.writeFile(file,JSON.stringify({pid:2147483647,token:'dead-owner'}));await assert.rejects(withElringWriteLease(file,async()=>{}),/VERIFIED_RECOVERY/);
 }finally{await fs.rm(dir,{recursive:true});}
});
