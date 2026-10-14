import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { inspectSnapshot, inspectManifest } from '../ops/price-engine-production-preflight.mjs';

const production = 'zjgueqijumzlfioihnkt';
const staging = 'kaxsqafdevabkxofwdod';
const sql = readFileSync(new URL('../ops/price-engine-production-preflight.sql', import.meta.url),'utf8');
let template;

test('metadata snapshot compiles on a database without feature tables and creates nothing', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create role authenticator;
      create schema storage; create table storage.buckets(id text primary key, public boolean, file_size_limit bigint, allowed_mime_types text[]);`);
    const before = (await db.query('select count(*)::int as count from pg_class')).rows[0].count;
    template = (await db.query(sql)).rows[0].price_engine_preflight;
    const after = (await db.query('select count(*)::int as count from pg_class')).rows[0].count;
    assert.equal(after,before);
    assert.equal(template.tables.length,32);
    assert.equal(template.tables.filter(row => row.present).length,0);
    const result = inspectSnapshot({project_ref:production,data:template},{phase:'baseline',expectedProject:production});
    assert.equal(result.ready,false);
    assert.ok(result.errors.includes('TABLE_MISSING:organizations'));
  } finally { await db.close(); }
});

function compatibleEnvelope(project_ref) {
  const data = structuredClone(template);
  for (const row of data.tables) Object.assign(row,{present:true,rls:true,service_select:true,service_insert:true,service_update:true,service_delete:false,anon_access:false,authenticated_access:false});
  for (const row of data.columns) Object.assign(row,{present:true,compatible:true});
  for (const row of data.functions) Object.assign(row,{present:true,service_execute:true,anon_execute:false,authenticated_execute:false,
    overloads:[{signature:row.signature||`${row.name}()`,definition_md5:'fixture-same',security_definer:true,config:['search_path=""']}]});
  for (const row of data.functions.filter(row => row.authenticated_storage_predicate))
    Object.assign(row,{service_execute:false,authenticated_execute:true});
  for (const row of data.functions.filter(row => row.owner_only))
    Object.assign(row,{service_execute:false});
  for (const row of data.indexes) Object.assign(row,{present:true,valid:true,ready:true});
  for (const row of data.buckets) Object.assign(row,{present:true,private:true,size_compatible:true,binary_compatible:true});
  for (const row of data.schemas) Object.assign(row,{present:true,anon_usage:false,authenticated_usage:false,service_usage:false});
  data.job_constraints = [{validated:true,definition:"CHECK (export_type IN ('admin_price_list','portal_price_list','catalog_master','catalog_export','supplier_report','supplier_price_list'))"}];
  return {project_ref,data};
}

test('wrong target and omitted metadata never pass the baseline gate', () => {
  const complete = compatibleEnvelope(staging);
  assert.ok(inspectSnapshot(complete,{expectedProject:production}).errors.includes('PROJECT_TARGET_UNCONFIRMED'));
  complete.project_ref=production;
  complete.data.functions=[];
  assert.ok(inspectSnapshot(complete,{expectedProject:production}).errors.includes('SNAPSHOT_REQUIREMENTS_INCOMPLETE:functions'));
});

test('multipart MIME and direct browser job access are independent runtime blockers', () => {
  const prod = compatibleEnvelope(production),reference = compatibleEnvelope(staging);
  assert.equal(inspectSnapshot(prod,{expectedProject:production,reference}).ready,true);
  prod.data.buckets.find(row => row.name==='app-exports').binary_compatible=false;
  prod.data.tables.find(row => row.name==='app_export_jobs').authenticated_access=true;
  const result=inspectSnapshot(prod,{expectedProject:production,reference});
  assert.equal(result.ready,false);
  assert.ok(result.errors.includes('BUCKET_INCOMPATIBLE:app-exports'));
  assert.ok(result.errors.includes('DIRECT_BROWSER_JOB_ACCESS:app_export_jobs'));
});

test('a different function body cannot pass on name and signature alone', () => {
  const prod=compatibleEnvelope(production),reference=compatibleEnvelope(staging);
  prod.data.functions.find(row=>row.name==='cloud_supplier_price_export_chunk_v3').overloads[0].definition_md5='old-production-body';
  assert.ok(inspectSnapshot(prod,{expectedProject:production,reference}).errors.includes('FUNCTION_DRIFT:cloud_supplier_price_export_chunk_v3'));
});

test('the explicit migration plan stays closed while foundation, canaries or file hashes are unconfirmed', () => {
  const manifest=JSON.parse(readFileSync(new URL('../ops/price-engine-production-manifest.json',import.meta.url),'utf8'));
  const result=inspectManifest(manifest);
  assert.equal(result.ready,false);
  assert.equal(result.errors.filter(e=>e.startsWith('MIGRATION_CHANGED:')).length,0);
  const missingFoundation = structuredClone(manifest);
  Object.assign(missingFoundation.migration_order.find(entry => entry.id === 'production-supplier-foundation'),{file:null,sha256:null});
  assert.ok(inspectManifest(missingFoundation).errors.includes('MIGRATION_CAPTURE_PENDING:production-supplier-foundation'));
  assert.ok(result.errors.includes('ACCEPTANCE_PENDING:all-exports-browser-canary'));
  const tampered=inspectManifest(manifest,{loadFile:()=>Buffer.from('wrong revision')});
  assert.ok(tampered.errors.some(e=>e.startsWith('MIGRATION_CHANGED:')));
});
