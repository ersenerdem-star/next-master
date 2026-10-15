import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
const sql=await readFile('supabase/migrations/20261015152030_portal_published_price_notifications.sql','utf8');
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('notify only current published prices to active tenant/brand customers; dedupe retries, backfill and both publication orderings',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table brands(id uuid,organization_id uuid,name text);
 create table portal_invites(id uuid,organization_id uuid,status text,party_type text,customer_id uuid,email text,allowed_brand_ids jsonb default '[]',excluded_brand_ids jsonb default '[]');
 create table supplier_price_publications(id uuid,release_id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,status text,publication_version integer,published_at timestamptz);
 create table supplier_current_price_pointers(organization_id uuid,supplier_id uuid,brand_id uuid,publication_id uuid,release_id uuid);
 create table portal_audit_logs(id uuid default gen_random_uuid(),organization_id uuid,invite_id uuid,party_type text,email text,event_type text,status text,details jsonb,created_at timestamptz default now());
 insert into brands values('${id(2)}','${id(1)}','Bosch');
 insert into portal_invites(id,organization_id,status,party_type,customer_id)values
 ('${id(10)}','${id(1)}','active','customer','${id(20)}'),
 ('${id(11)}','${id(1)}','disabled','customer','${id(20)}'),
 ('${id(12)}','${id(3)}','active','customer','${id(20)}'),
 ('${id(13)}','${id(1)}','active','vendor','${id(20)}'),
 ('${id(14)}','${id(1)}','active','customer','${id(20)}'),
 ('${id(15)}','${id(1)}','active','customer','${id(20)}');
 update portal_invites set excluded_brand_ids='["${id(2)}"]' where id='${id(14)}';
 update portal_invites set allowed_brand_ids='["${id(9)}"]' where id='${id(15)}';
 insert into supplier_price_publications values('${id(30)}','${id(31)}','${id(1)}','${id(4)}','${id(2)}','published',1,now());
 insert into supplier_current_price_pointers values('${id(1)}','${id(4)}','${id(2)}','${id(30)}','${id(31)}');`);
 await db.exec(sql);
 const notices=async()=>(await db.query('select * from portal_audit_logs')).rows;
 assert.equal((await notices()).length,1);assert.equal((await notices())[0].invite_id,id(10));assert.match((await notices())[0].details.message,/new Bosch price list/);
 await db.query('select public.emit_portal_published_price_notice($1)',[id(30)]);assert.equal((await notices()).length,1);
 await db.exec(`insert into supplier_price_publications values('${id(40)}','${id(41)}','${id(1)}','${id(4)}','${id(2)}','published',2,now())`);
 assert.equal((await notices()).length,1,'publication without current pointer cannot notify');
 await db.exec(`update supplier_current_price_pointers set publication_id='${id(40)}',release_id='${id(41)}'`);
 assert.equal((await notices()).length,2,'new current publication creates one new notice');
 await db.exec(`update supplier_current_price_pointers set publication_id=publication_id; update supplier_price_publications set status='published' where id='${id(40)}'`);
 assert.equal((await notices()).length,2);
 await db.exec(`insert into supplier_price_publications values('${id(50)}','${id(51)}','${id(1)}','${id(4)}','${id(2)}','validated',3,null);update supplier_current_price_pointers set publication_id='${id(50)}',release_id='${id(51)}'`);
 assert.equal((await notices()).length,2,'validated is not published');
 await db.exec(`update supplier_price_publications set status='published',published_at=now() where id='${id(50)}'`);
 assert.equal((await notices()).length,3,'pointer-first publication also notifies once');
 await db.exec(`update supplier_current_price_pointers set release_id='${id(99)}'`);
 await db.query('select public.emit_portal_published_price_notice($1)',[id(50)]);assert.equal((await notices()).length,3,'mismatched release cannot notify');
 for(const role of ['anon','authenticated','service_role']){await db.exec('set role '+role);await assert.rejects(db.query('select public.emit_portal_published_price_notice($1)',[id(50)]),/permission denied/);await db.exec('reset role');}
 }finally{await db.close();}
});
