import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const sql=readFileSync(new URL('../ops/price-engine-production-customer-alignment.sql',import.meta.url),'utf8');
const customerId='fd9f8834-7935-4050-8895-fde8a2eb4914';
const orgId='1e4c5e99-e387-41aa-a6d3-cbe74558f766';
async function fixture({type='C',margin=null,fields='Notes[[NEXT_MASTER_META]]{"price_list_type":"C","unrelated":"preserved"}',missing=false}={}) {
  const db=new PGlite();
  await db.exec(`create table customers(id uuid primary key,organization_id uuid,price_list_type text,price_list_margin_percent numeric,custom_fields text,updated_at timestamptz);`);
  if(!missing) await db.query(`insert into customers values($1,$2,$3,$4,$5,'2000-01-01')`,[customerId,orgId,type,margin,fields]);
  await db.query(`insert into customers values('00000000-0000-4000-8000-000000000001',$1,'Other',null,$2,'2000-01-01')`,[orgId,'[[NEXT_MASTER_META]]{"price_list_margin_percent":20}']);
  return db;
}
test('approved C-to-A alignment preserves notes, unrelated metadata and every other account',async()=>{
  const db=await fixture();
  try {
    const otherBefore=(await db.query('select * from customers where id<>$1',[customerId])).rows;
    await db.exec(sql);
    const row=(await db.query('select * from customers where id=$1',[customerId])).rows[0];
    assert.equal(row.price_list_type,'A');
    assert.equal(row.price_list_margin_percent,null);
    assert.ok(row.custom_fields.startsWith('Notes[[NEXT_MASTER_META]]'));
    assert.deepEqual(JSON.parse(row.custom_fields.split('[[NEXT_MASTER_META]]')[1]),{price_list_type:'A',unrelated:'preserved'});
    assert.deepEqual((await db.query('select * from customers where id<>$1',[customerId])).rows,otherBefore);
    await db.exec(sql);
    assert.deepEqual((await db.query('select * from customers where id=$1',[customerId])).rows[0],row);
  } finally {await db.close();}
});
test('missing or changed approved customer fails without changing any account',async()=>{
  for(const options of [{missing:true},{type:'B'},{type:null},{margin:7},{fields:'[[NEXT_MASTER_META]]{"price_list_type":"Other"}'},{fields:'[[NEXT_MASTER_META]]{"price_list_margin_percent":12}'},{fields:'[[NEXT_MASTER_META]]broken'}]) {
    const db=await fixture(options);
    try {
      const before=(await db.query('select * from customers order by id')).rows;
      await assert.rejects(db.exec(sql),/PRICE_PROFILE_/);
      assert.deepEqual((await db.query('select * from customers order by id')).rows,before);
    } finally {await db.close();}
  }
});
