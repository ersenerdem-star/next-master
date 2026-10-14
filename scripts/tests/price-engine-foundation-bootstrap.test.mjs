import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateFoundationBootstrap } from "../ops/generate-price-engine-foundation-bootstrap.mjs";
import { createFoundationTestDb as makeDb, seedFoundationTestScope as seedScope, executeFixtureMigration } from "./fixtures/price-engine-foundation-db.mjs";

const source = JSON.parse(await readFile(new URL("./fixtures/price-engine-foundation-source.json", import.meta.url), "utf8"));
const migration = await readFile(new URL("../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql", import.meta.url), "utf8");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
async function apply(db) {
  return executeFixtureMigration(db,migration);
}

test("foundation SQL is deterministic and excludes staging publisher, fixtures and browser writes", () => {
  assert.equal(generateFoundationBootstrap(source),migration);
  assert.equal(source.tables.length,12);
  assert.equal(source.functions.filter((fn) => fn.schema === "public").length,24);
  assert.doesNotMatch(migration,/CREATE (?:OR REPLACE )?FUNCTION public\.publish_supplier_price_release_staging/i);
  assert.doesNotMatch(migration,/GRANT (?:TRUNCATE|TRIGGER|REFERENCES).*TO (?:anon|authenticated)/i);
  assert.doesNotMatch(migration,/UPDATE public\.(?:supplier_prices|catalog_products|customers)|DELETE FROM public\.(?:supplier_prices|catalog_products|customers)/i);
});

test("foundation applies, replays without data changes and retains complete identity/FK/index/RLS contracts", async () => {
  const db = await makeDb();
  try {
    await apply(db);
    await seedScope(db);
    await db.query(`INSERT INTO public.supplier_price_releases(id,organization_id,supplier_id,brand_id,source_file_path,source_file_sha256,created_by) VALUES($1,$2,$3,$4,'source.csv',$5,$6)`,[id(9),id(1),id(3),id(5),"a".repeat(64),id(7)]);
    await apply(db);
    assert.equal((await db.query("SELECT count(*)::int n FROM public.supplier_price_releases")).rows[0].n,1);
    for (const table of source.tables) {
      const relation = `${table.schema}.${table.name}`;
      const info = (await db.query("SELECT relrowsecurity rls FROM pg_class WHERE oid=$1::regclass",[relation])).rows[0];
      assert.equal(info.rls,true,relation);
      const columns = (await db.query("SELECT attname name,format_type(atttypid,atttypmod) type,attnotnull not_null,attidentity identity FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",[relation])).rows;
      assert.deepEqual(columns.map((column) => ({ name:column.name,type:column.type,notNull:column.not_null,identity:column.identity })),table.columns.map((column) => ({name:column.name,type:column.type,notNull:column.notNull,identity:column.identity||""})),relation);
      const constraints = (await db.query("SELECT conname name,pg_get_constraintdef(oid,true) definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname",[relation])).rows;
      assert.deepEqual(constraints,table.constraints.map((constraint) => ({name:constraint.name,definition:constraint.definition})).sort((a,b)=>a.name.localeCompare(b.name)),relation);
      assert.equal((await db.query("SELECT count(*)::int n FROM pg_index WHERE indrelid=$1::regclass AND indisvalid",[relation])).rows[0].n,table.indexes.length,relation);
      for (const who of ["anon","authenticated"]) {
        const privileges = (await db.query("SELECT has_table_privilege($1,$2,'TRUNCATE,TRIGGER,REFERENCES') unsafe,has_table_privilege($1,$2,'INSERT,UPDATE,DELETE') write",[who,relation])).rows[0];
        assert.deepEqual(privileges,{unsafe:false,write:false},`${who}:${relation}`);
      }
    }
    for (const table of source.tables.filter((table)=>table.columns.some((column)=>column.identity))) {
      const sequence = (await db.query("SELECT s.seqstart::text start,s.seqincrement::text increment,s.seqmin::text min,s.seqmax::text max,s.seqcache::text cache,s.seqcycle cycle FROM pg_sequence s WHERE s.seqrelid=pg_get_serial_sequence($1,'id')::regclass",[`${table.schema}.${table.name}`])).rows[0];
      assert.deepEqual(sequence,{start:"1",increment:"1",min:"1",max:"9223372036854775807",cache:"1",cycle:false});
    }
    assert.equal((await db.query("SELECT has_schema_privilege('authenticated','supplier_price_ingestion_internal','USAGE') access")).rows[0].access,false);
    for (const fn of source.functions) {
      const signature=`${fn.schema}.${fn.name}(${fn.args.split(',').filter(Boolean).map((arg)=>arg.trim().replace(/^\w+\s+/, '')).join(',')})`;
      const acl=(await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service",[signature])).rows[0];
      assert.deepEqual(acl,{anon:false,authenticated:String(fn.grants||'').includes('authenticated=X/'),service:String(fn.grants||'').includes('service_role=X/')},signature);
    }
  } finally { await db.close(); }
});

test("bootstrap rejects baseline drift atomically before creating new business tables", async () => {
  const db = await makeDb();
  try {
    await db.exec("ALTER TABLE public.profiles ALTER COLUMN is_active TYPE text USING is_active::text");
    await assert.rejects(apply(db),/BASELINE_COLUMN_DRIFT.*profiles.is_active/);
    await db.exec("ROLLBACK");
    assert.equal((await db.query("SELECT to_regclass('public.supplier_price_releases') present")).rows[0].present,null);
  } finally { await db.close(); }
});

test("service upload admission binds tenant, actor and stable replay and release readers obey org RLS", async () => {
  const db = await makeDb();
  try {
    await apply(db); await seedScope(db);
    const args=[id(1),id(7),id(3),id(5),"source.csv","text/csv",100,"a".repeat(64),"admission-replay-1","replace",null];
    const admission="SELECT * FROM public.start_supplier_price_upload_session($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)";
    const first=(await db.query(admission,args)).rows[0];
    assert.deepEqual((await db.query(admission,args)).rows[0],first);
    await assert.rejects(db.query(admission,[...args.slice(0,2),id(4),...args.slice(3)]),/Supplier is not in this organization/);
    await assert.rejects(db.query(admission,[...args.slice(0,7),"b".repeat(64),...args.slice(8)]),/UPLOAD_REQUEST_CONFLICT/);
    await db.exec("SET ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',false)");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id(7)]);
    assert.equal((await db.query("SELECT count(*)::int n FROM public.supplier_price_releases")).rows[0].n,1);
    await assert.rejects(db.query(admission,args),/permission denied/);
    await assert.rejects(db.exec("TRUNCATE public.supplier_price_releases"),/permission denied/);
    await db.exec("RESET ROLE; UPDATE public.profiles SET organization_id='00000000-0000-4000-8000-000000000002'; SET ROLE authenticated");
    assert.equal((await db.query("SELECT count(*)::int n FROM public.supplier_price_releases")).rows[0].n,0);
  } finally { await db.close(); }
});

test("verification queue lease cannot be settled by a different worker or token and prepared Storage is denied", async () => {
  const db = await makeDb();
  try {
    await apply(db); await seedScope(db);
    const admission=(await db.query("SELECT public.start_supplier_price_verified_upload_session($1,$2,$3,$4,'source.csv','text/csv',100,$5,'verification-1','replace',null) result",[id(1),id(7),id(3),id(5),"a".repeat(64)])).rows[0].result;
    await db.query("UPDATE public.supplier_price_upload_sessions SET status='uploaded',uploaded_bytes=100 WHERE id=$1",[admission.session_id]);
    await db.query("INSERT INTO storage.objects(id,bucket_id,name,version,updated_at,metadata) VALUES($1,'supplier-price-imports',$2,'object-v1',now(),$3)",[id(80),admission.storage_object_path,{size:100}]);
    await db.query("SELECT public.request_supplier_price_upload_verification($1,$2,$3,$4,extract(epoch from now())::bigint,extract(epoch from now()+interval '1 hour')::bigint)",[admission.session_id,id(7),id(1),id(8)]);
    const claimed=(await db.query("SELECT public.claim_supplier_price_upload_verification('worker-1',60) result")).rows[0].result;
    assert.ok(claimed.request_id);
    await assert.rejects(db.query("SELECT public.settle_supplier_price_upload_verification($1,'worker-2',$2,'retry',60,'TEST')",[claimed.request_id,claimed.lease_token]),/LEASE|lease|owner/);
    await assert.rejects(db.query("SELECT public.settle_supplier_price_upload_verification($1,'worker-1',$2,'retry',60,'TEST')",[claimed.request_id,id(99)]),/LEASE|lease|owner/);
    await db.query("SELECT public.settle_supplier_price_upload_verification($1,'worker-1',$2,'retry',60,'TEST')",[claimed.request_id,claimed.lease_token]);
    await db.query("INSERT INTO storage.objects(id,bucket_id,name) VALUES($1,'supplier-price-prepared','prepared.csv')",[id(90)]);
    await db.exec("SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id(7)]);
    assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='supplier-price-imports'")).rows[0].n,1);
    assert.equal((await db.query("UPDATE storage.objects SET version='forged' WHERE id=$1 RETURNING id",[id(80)])).rows.length,0);
    assert.equal((await db.query("DELETE FROM storage.objects WHERE id=$1 RETURNING id",[id(80)])).rows.length,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='supplier-price-prepared'")).rows[0].n,0);
    await assert.rejects(db.query("INSERT INTO storage.objects(id,bucket_id,name) VALUES($1,'supplier-price-prepared','forged.csv')",[id(91)]),/row-level security/);
    await db.exec("RESET ROLE; UPDATE public.profiles SET organization_id='00000000-0000-4000-8000-000000000002'; SET ROLE authenticated");
    assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='supplier-price-imports'")).rows[0].n,0);
    await db.exec("RESET ROLE; SET ROLE anon");
    assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id IN('supplier-price-imports','supplier-price-prepared')")).rows[0].n,0);
  } finally { await db.close(); }
});
