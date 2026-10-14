import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {buildPlan,extractReviewedIndexes,COMPACT_SEARCH_OVERRIDE,REVIEWED_INDEXES}
 from '../ops/price-engine-production-index-prebuild.mjs';

const repo=new URL('../../',import.meta.url),hash=value=>createHash('sha256').update(value).digest('hex');
const migration=await readFile(new URL(COMPACT_SEARCH_OVERRIDE.source,repo),'utf8');
const base=JSON.parse(await readFile(new URL('../ops/price-engine-production-manifest.json',import.meta.url),'utf8'));
const legacyManifest=structuredClone(base);
legacyManifest.migration_order=legacyManifest.migration_order.filter(entry=>entry.file!==COMPACT_SEARCH_OVERRIDE.source);
const compactManifest=structuredClone(legacyManifest);
compactManifest.migration_order.splice(compactManifest.migration_order.findIndex(entry=>entry.file===COMPACT_SEARCH_OVERRIDE.superseded_source),0,
 {id:'20261014145352_supplier_price_export_compact_search_index',file:COMPACT_SEARCH_OVERRIDE.source,sha256:hash(migration),phase:'supplier-export'});
const bytes=manifest=>Buffer.from(JSON.stringify(manifest));
const legacy=await buildPlan({bytes:bytes(legacyManifest)});
const compact=await buildPlan({bytes:bytes(compactManifest)});
const wide=legacy.operations.find(item=>item.name===COMPACT_SEARCH_OVERRIDE.name);
const narrow=compact.operations.find(item=>item.name===COMPACT_SEARCH_OVERRIDE.name);

test('explicit compact supersession pins both source hashes while preserving the12 operation order',()=>{
 assert.equal(hash(migration),COMPACT_SEARCH_OVERRIDE.source_sha256);
 assert.deepEqual(compact.operations.map(item=>item.name),REVIEWED_INDEXES.map(item=>item.name));
 assert.equal(narrow.source.file,COMPACT_SEARCH_OVERRIDE.source);
 assert.equal(narrow.source_sql_sha256,COMPACT_SEARCH_OVERRIDE.source_sql_sha256);
 assert.match(narrow.sql,/normalized_code text_pattern_ops/);assert.doesNotMatch(narrow.sql,/normalized_oem|product_code/);
 assert.equal(narrow.superseded_in.length,1);
 assert.equal(narrow.superseded_in[0].file,COMPACT_SEARCH_OVERRIDE.superseded_source);
 assert.equal(narrow.superseded_in[0].source_sql_sha256,wide.source_sql_sha256);
 assert.equal(narrow.source.migration_position+1,narrow.superseded_in[0].migration_position);
 for(const item of legacy.operations.filter(item=>item.name!==wide.name)){
  const current=compact.operations.find(candidate=>candidate.name===item.name);
  assert.equal(current.sql,item.sql);assert.equal(current.expected_definition,item.expected_definition);
 }
 assert.equal(wide.superseded_in,undefined);assert.match(wide.sql,/normalized_oem/);
});

test('wrong placement and altered historical or compact bytes cannot masquerade as the approved supersession',async()=>{
 const late=structuredClone(compactManifest),entry=late.migration_order.splice(narrow.source.migration_position-1,1)[0];
 late.migration_order.push(entry);
 await assert.rejects(extractReviewedIndexes(bytes(late)),/INDEX_SUPERSESSION_SOURCE_OR_ORDER_INVALID/);
 for(const path of [COMPACT_SEARCH_OVERRIDE.source,COMPACT_SEARCH_OVERRIDE.superseded_source]){
  const changed=structuredClone(compactManifest),original=await readFile(new URL(path,repo));
  const altered=Buffer.concat([original,Buffer.from('\n-- unauthorized drift\n')]);
  changed.migration_order.find(item=>item.file===path).sha256=hash(altered);
  await assert.rejects(extractReviewedIndexes(bytes(changed),{loadFile:file=>file===path?altered:readFile(new URL(file,repo))}),
   /INDEX_SUPERSESSION_SOURCE_OR_ORDER_INVALID|INDEX_SUPERSEDED_DEFINITION_CHANGED/);
 }
});

async function fixture(){
 const db=new PGlite({extensions:{pg_trgm}});
 await db.exec(`CREATE EXTENSION pg_trgm;
  CREATE TABLE public.supplier_prices(organization_id uuid,supplier_id uuid,brand_id uuid,
   normalized_code text,normalized_oem text,product_code text,id uuid,is_active boolean);
  INSERT INTO public.supplier_prices SELECT '11111111-1111-4111-8111-111111111111',
   '22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',
   'CODE123',string_agg(upper(md5(g::text)),''),'CODE-123','44444444-4444-4444-8444-444444444444',true
  FROM generate_series(1,330) g;`);
 return db;
}
const rows=db=>db.query('SELECT to_jsonb(r) value FROM public.supplier_prices r ORDER BY id').then(result=>result.rows);

test('real PG17 wide index fails54000, compact index accepts oversizedOEM and historical CREATE safely skips',async()=>{
 const db=await fixture();
 try{
  const before=await rows(db);assert.equal(before[0].value.normalized_oem.length,10560);
  await assert.rejects(db.exec(wide.source_sql),error=>error.code==='54000');
  await db.exec('BEGIN');await db.exec(migration);await db.exec('COMMIT');
  await db.exec(wide.source_sql); // Exact historical bytes must find the existing compact name.
  await db.exec('BEGIN');await db.exec(migration);await db.exec('COMMIT');
  await db.exec("SET search_path=pg_catalog");
  const actual=(await db.query(`SELECT pg_get_indexdef(c.oid) definition,i.indisvalid valid,i.indisready ready
   FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.oid='public.idx_supplier_prices_export_search'::regclass`)).rows[0];
  assert.deepEqual(actual,{definition:narrow.expected_definition,valid:true,ready:true});
  assert.deepEqual(await rows(db),before);
  await db.exec(`CREATE INDEX fixture_oem_search ON public.supplier_prices USING gin(normalized_oem public.gin_trgm_ops);
   INSERT INTO public.supplier_prices SELECT organization_id,supplier_id,brand_id,'CODE124',normalized_oem,
    'CODE-124','55555555-5555-4555-8555-555555555555',true FROM public.supplier_prices;
   UPDATE public.supplier_prices SET normalized_oem=normalized_oem||upper(md5('another-oem')) WHERE product_code='CODE-124';`);
  const matches=(await db.query(`SELECT count(*)::int n FROM public.supplier_prices WHERE normalized_code LIKE 'CODE%'
   AND normalized_oem LIKE '%'||upper(md5('175'))||'%'`)).rows[0].n;
  assert.equal(matches,2);
  assert.equal((await rows(db))[0].value.normalized_oem,before[0].value.normalized_oem);
 }finally{await db.close();}
});

test('forward migration refuses an existing wide index without replacing it or changing business rows',async()=>{
 const db=await fixture();
 try{
  await db.exec("UPDATE public.supplier_prices SET normalized_oem='SMALL'");await db.exec(wide.source_sql);
  const before=await rows(db);
  await db.exec('BEGIN');await assert.rejects(db.exec(migration),/SUPPLIER_EXPORT_COMPACT_SEARCH_INDEX_REVIEW_REQUIRED/);await db.exec('ROLLBACK');
  await db.exec('SET search_path=pg_catalog');
  const actual=(await db.query("SELECT pg_get_indexdef('public.idx_supplier_prices_export_search'::regclass) definition")).rows[0].definition;
  assert.equal(actual,wide.expected_definition);assert.deepEqual(await rows(db),before);
 }finally{await db.close();}
});
