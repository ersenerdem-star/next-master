import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const sql=await readFile('supabase/migrations/20261015135403_portal_brand_default_all_exclusions.sql','utf8');
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('all current/future brands by default; explicit exclusions survive additions, never cross tenants or reopen an empty scope',async()=>{
 const db=new PGlite();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table brands(id uuid primary key,organization_id uuid,name text);
 create table portal_invites(id uuid primary key,organization_id uuid,allowed_brand_ids jsonb default '[]',updated_at timestamptz default '2026-01-01');
 insert into brands values('${id(2)}','${id(1)}','A'),('${id(3)}','${id(1)}','B'),('${id(5)}','${id(4)}','Foreign');
 insert into portal_invites(id,organization_id,allowed_brand_ids)values('${id(6)}','${id(1)}','["${id(2)}"]');`);
 await db.exec(sql);
 const scope=async()=>(await db.query('select * from portal_invites where id=$1',[id(6)])).rows[0];
 assert.deepEqual((await scope()).allowed_brand_ids,[],'existing whitelist reset as requested');
 await db.query('insert into portal_invites(id,organization_id)values($1,$2)',[id(7),id(1)]);
 await db.query('update portal_invites set excluded_brand_ids=$1 where id=$2',[JSON.stringify([id(2)]),id(6)]);
 assert.deepEqual((await scope()).allowed_brand_ids,[id(3)]);
 await db.query('insert into brands values($1,$2,$3)',[id(8),id(1),'New brand']);
 assert.deepEqual((await scope()).allowed_brand_ids,[id(3),id(8)],'new brand enabled without admin resave');
 assert.equal((await scope()).updated_at.toISOString(),'2026-01-01T00:00:00.000Z','new brand does not invalidate sessions');
 assert.deepEqual((await db.query('select allowed_brand_ids from portal_invites where id=$1',[id(7)])).rows[0].allowed_brand_ids,[]);
 await assert.rejects(db.query('update portal_invites set excluded_brand_ids=$1 where id=$2',[JSON.stringify([id(5)]),id(6)]),/PORTAL_EXCLUDED_BRAND_SCOPE_INVALID/);
 await assert.rejects(db.query('update portal_invites set excluded_brand_ids=$1 where id=$2',['[42]',id(6)]),/PORTAL_EXCLUDED_BRAND_SCOPE_INVALID/);
 await db.query('update portal_invites set excluded_brand_ids=$1 where id=$2',[JSON.stringify([id(2),id(3),id(8)]),id(6)]);
 assert.deepEqual((await scope()).allowed_brand_ids,['00000000-0000-0000-0000-000000000000'],'exclude all is deny all, never legacy []=all');
 await db.query('insert into brands values($1,$2,$3)',[id(9),id(1),'Later']);
 assert.deepEqual((await scope()).allowed_brand_ids,[id(9)]);
 await db.query('delete from brands where id=$1',[id(2)]);
 assert.deepEqual((await scope()).excluded_brand_ids,[id(3),id(8)]);
 await db.query('update portal_invites set excluded_brand_ids=$1 where id=$2',['[]',id(6)]);
 assert.deepEqual((await scope()).allowed_brand_ids,[]);
 assert.equal((await db.query(`select has_function_privilege('anon','public.sync_portal_brand_exclusions()','execute') can_call`)).rows[0].can_call,false);
 }finally{await db.close();}
});
