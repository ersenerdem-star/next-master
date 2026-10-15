import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureBrandRecord} from '../../apps/web/src/shared/brandCreation.ts';

test('same registry identity reuses the existing brand without inserting or renaming',async()=>{
 let inserts=0;
 const existing={id:'brand-id',name:'Blue Print'};
 const result=await ensureBrandRecord(' blue-print ',{
  find:async key=>{assert.equal(key,'BLUEPRINT');return existing;},
  insert:async()=>{inserts++;throw Error('must not insert');},
 });
 assert.deepEqual(result,{brand:existing,created:false});assert.equal(inserts,0);
});
test('new name is normalized and creates only the requested brand record',async()=>{
 const result=await ensureBrandRecord('  Brand   Example  ',{
  find:async()=>null,
  insert:async name=>{assert.equal(name,'Brand Example');return {id:'new-id',name};},
 });
 assert.deepEqual(result,{brand:{id:'new-id',name:'Brand Example'},created:true});
});
test('concurrent submissions converge on one database-unique identity',async()=>{
 let stored:null|{id:string;name:string}=null;let writes=0;
 const store={find:async()=>stored,insert:async(name:string)=>{
  if(stored)throw Object.assign(Error('duplicate'),{code:'23505'});
  writes++;stored={id:'one-id',name};return stored;
 }};
 const result=await Promise.all([ensureBrandRecord('Brand Example',store),ensureBrandRecord('BRAND-EXAMPLE',store)]);
 assert.equal(writes,1);assert.equal(result[0].brand.id,result[1].brand.id);
 assert.deepEqual(result.map(item=>item.created).sort(),[false,true]);
});
test('lost insertion response is reconciled; authorization/network failures cannot fabricate success',async()=>{
 let committed=false;
 const recovered=await ensureBrandRecord('Example',{
  find:async()=>committed?{id:'saved-id',name:'Example'}:null,
  insert:async()=>{committed=true;throw Error('response lost');},
 });
 assert.equal(recovered.brand.id,'saved-id');assert.equal(recovered.created,false);
 await assert.rejects(ensureBrandRecord('Denied',{
  find:async()=>null,insert:async()=>{throw Error('RLS denied');},
 }),/RLS denied/);
 let attempted=false;
 await assert.rejects(ensureBrandRecord('Hidden',{
  find:async()=>{throw Error('lookup denied');},insert:async()=>{attempted=true;throw Error('unexpected');},
 }),/lookup denied/);
 assert.equal(attempted,false);
});
test('invalid names cause no registry reads or writes',async()=>{
 const never=async()=>{throw Error('store must not be called');};
 for(const name of ['', ' --- ', 'X'.repeat(121),'Brand\u0000Name']){
  await assert.rejects(ensureBrandRecord(name,{find:never,insert:never}),/BRAND_NAME_INVALID/);
 }
});
