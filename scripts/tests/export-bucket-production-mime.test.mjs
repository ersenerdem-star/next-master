import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const migrationPath=new URL('../../supabase/migrations/20261014120514_app_exports_multipart_mime_capability.sql',import.meta.url);
const sql=await readFile(migrationPath,'utf8');
async function fixture() {
  const db=new PGlite();
  await db.exec(`create schema storage; create table storage.buckets(
    id text primary key,name text not null,public boolean not null,
    file_size_limit bigint,allowed_mime_types text[],updated_at timestamptz not null default now());
    insert into storage.buckets values('app-exports','app-exports',false,104857600,
      array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/json'],
      '2026-10-06T00:00:00Z'),('unrelated','unrelated',true,1234,array['image/png'],'2026-10-06T00:00:00Z');`);
  return db;
}
async function buckets(db) {return (await db.query('select * from storage.buckets order by id')).rows;}

test('multipart MIME upgrade preserves production capacity, privacy, existing types and other buckets; replay has no write',async()=>{
  const db=await fixture();
  try {
    const before=await buckets(db);
    await db.exec(sql);
    const after=await buckets(db);
    assert.equal(after[0].public,false);
    assert.equal(after[0].file_size_limit,104857600);
    assert.deepEqual(after[0].allowed_mime_types,[...before[0].allowed_mime_types,'application/octet-stream']);
    assert.deepEqual(after[1],before[1]);
    await db.exec(sql);
    assert.deepEqual(await buckets(db),after);
  } finally {await db.close();}
});
test('unrestricted private MIME policy stays unrestricted and unchanged',async()=>{
  const db=await fixture();
  try {
    await db.exec("update storage.buckets set allowed_mime_types=null where id='app-exports';");
    const before=await buckets(db);await db.exec(sql);
    assert.deepEqual(await buckets(db),before);
  } finally {await db.close();}
});
test('missing, public or undersized export bucket fails atomically without changes',async()=>{
  for(const setup of ["delete from storage.buckets where id='app-exports'", "update storage.buckets set public=true where id='app-exports'", "update storage.buckets set file_size_limit=41943039 where id='app-exports'"]) {
    const db=await fixture();
    try {
      await db.exec(setup);const before=await buckets(db);
      await assert.rejects(()=>db.exec(sql),/APP_EXPORT_BUCKET_/);
      await db.exec('rollback');assert.deepEqual(await buckets(db),before);
    } finally {await db.close();}
  }
});
