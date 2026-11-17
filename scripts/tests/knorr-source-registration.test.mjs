import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
const sql=await readFile(new URL('../../supabase/migrations/20261117093117_knorr_official_wilmink_source_registration.sql',import.meta.url),'utf8');
test('registration is idempotent, scoped, disabled, preserves existing source and prices',async()=>{
 const db=new PGlite();await db.exec(`create table brands(organization_id uuid,name text);create table catalog_external_sources(id uuid,organization_id uuid,source_key text,display_name text,source_owner text,source_type text check(source_type in('manufacturer','external_catalog')),base_url text,license_posture text,robots_posture text,rate_limit_posture text,credential_boundary text,is_active bool,metadata jsonb);create table prices(value int);insert into brands values('00000000-0000-0000-0000-000000000001','Knorr-Bremse');insert into prices values(37);`);
 await db.exec(sql);await db.exec(sql);
 const result=await db.query('select source_key, metadata from catalog_external_sources order by source_key');assert.equal(result.rows.length,2);for(const row of result.rows){assert.equal(row.metadata.brand_engine_read_allowed,false);assert.equal(row.metadata.automatic_apply,false);}
 assert.equal((await db.query('select value from prices')).rows[0].value,37);await db.close();
});
