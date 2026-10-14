import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createFullReplayDb } from "./fixtures/price-engine-full-replay-db.mjs";

const root = new URL("../../", import.meta.url);
const migrationFile = "supabase/migrations/20261014132434_catalog_finalize_preserve_validation_counts.sql";
const migration = await readFile(new URL(migrationFile, root), "utf8");
const manifest = JSON.parse(await readFile(new URL("scripts/ops/price-engine-production-manifest.json", root), "utf8"));
const signature = "public.finalize_catalog_import_batch_pre_dimensions(uuid,integer)";
const baselineHash = "b6c02073f9dd230457e1901e3598c2c9";
const fixedHash = "62438b8bbf47eeba619f9ec937ed64a2";

async function seedRun(db, rows, mode = "upsert") {
  const org = randomUUID(), actor = randomUUID(), brand = randomUUID(), run = randomUUID();
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic catalog counter test')", [org]);
  await db.query("INSERT INTO profiles(id,organization_id,email,role,is_active) VALUES($1,$2,$3,'admin',true)", [actor, org, `${actor}@example.invalid`]);
  await db.query("INSERT INTO brands(id,organization_id,name) VALUES($1,$2,'CounterTest')", [brand, org]);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','service_role',false)", [actor]);
  await db.query("INSERT INTO catalog_import_runs(id,organization_id,created_by,mode) VALUES($1,$2,$3,$4)", [run, org, actor, mode]);
  for (const [index, row] of rows.entries()) {
    const code = `COUNTER${index}`;
    if (row.existing !== undefined) {
      await db.query("INSERT INTO catalog_products(organization_id,brand_id,product_code,description,lifecycle_status) VALUES($1,$2,$3,$4,'active')", [org, brand, code, row.existing]);
    }
    await db.query(`INSERT INTO catalog_import_stage(organization_id,run_id,row_index,brand,product_code,normalized_code,description,lifecycle_status,image_url)
      VALUES($1,$2,$3,'CounterTest',$4,$4,$5,'active',$6)`, [org, run, index, code, row.description, row.image ?? null]);
  }
  const validation = (await db.query("SELECT validate_catalog_import_storage_batch_system($1,$2,$3,100) result", [run, org, actor])).rows[0].result;
  assert.equal(validation.status, "validated");
  return { org, actor, brand, run, validation };
}

async function finalize(db, fixture, size) {
  return (await db.query("SELECT finalize_catalog_import_batch_system($1,$2,$3,$4) result", [fixture.run, fixture.org, fixture.actor, size])).rows[0].result;
}

async function counts(db, fixture) {
  return (await db.query(`SELECT status,insert_rows,update_rows,skip_rows,inserted_count,updated_count,skipped_count,
    processed_rows,finalize_cursor,image_quarantined_count FROM catalog_import_runs WHERE id=$1`, [fixture.run])).rows[0];
}

async function products(db, fixture) {
  return (await db.query("SELECT to_jsonb(p) product FROM catalog_products p WHERE organization_id=$1 ORDER BY product_code", [fixture.org])).rows.map(row => row.product);
}

function assertCounts(row, { planned, actual, processed, cursor, status = "finalized", images = 0 }) {
  assert.deepEqual([row.insert_rows, row.update_rows, row.skip_rows], planned);
  assert.deepEqual([row.inserted_count, row.updated_count, row.skipped_count], actual);
  assert.equal(row.processed_rows, processed);
  assert.equal(row.finalize_cursor, cursor);
  assert.equal(row.status, status);
  assert.equal(row.image_quarantined_count, images);
}

test("catalog finalization preserves validation plans and processes every bounded row in actual PG17", async t => {
  const db = await createFullReplayDb();
  try {
    // Replay the current reviewed chain, leaving this forward fix unapplied so
    // the regression proves the old behavior before exercising the correction.
    for (const entry of manifest.migration_order) {
      if (entry.file !== migrationFile) await db.exec(await readFile(new URL(entry.file, root), "utf8"));
    }
    assert.equal((await db.query("SELECT md5(pg_get_functiondef($1::regprocedure)) hash", [signature])).rows[0].hash, baselineHash);
    const wrappersBefore = (await db.query("SELECT proname,proacl::text,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid IN ('public.finalize_catalog_import_batch(uuid,integer)'::regprocedure,'public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer)'::regprocedure) ORDER BY proname")).rows;
    const privilegeBefore = (await db.query("SELECT proacl::text acl,proowner::regrole::text owner FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows;

    await t.test("reproduces original double count and applies without rewriting historical runs", async () => {
      const historical = await seedRun(db, [0, 1, 2].map(() => ({ description: "New product" })));
      await finalize(db, historical, 2);
      await finalize(db, historical, 2);
      assertCounts(await counts(db, historical), { planned: [6, 0, 0], actual: [3, 0, 0], processed: 3, cursor: 2 });
      assert.equal((await products(db, historical)).length, 3);
      const before = (await db.query("SELECT to_jsonb(r) row FROM catalog_import_runs r WHERE id=$1", [historical.run])).rows;
      await db.exec(migration);
      await db.exec(migration);
      assert.equal((await db.query("SELECT md5(pg_get_functiondef($1::regprocedure)) hash", [signature])).rows[0].hash, fixedHash);
      assert.deepEqual((await db.query("SELECT to_jsonb(r) row FROM catalog_import_runs r WHERE id=$1", [historical.run])).rows, before);
      assert.deepEqual((await db.query("SELECT proacl::text acl,proowner::regrole::text owner FROM pg_proc WHERE oid=$1::regprocedure", [signature])).rows, privilegeBefore);
      assert.deepEqual((await db.query("SELECT proname,proacl::text,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid IN ('public.finalize_catalog_import_batch(uuid,integer)'::regprocedure,'public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer)'::regprocedure) ORDER BY proname")).rows, wrappersBefore);
    });

    await t.test("three inserts retain the plan through two batches and finalized replay", async () => {
      const fixture = await seedRun(db, [0, 1, 2].map(() => ({ description: "New product" })));
      assert.equal((await finalize(db, fixture, 2)).batch_processed, 2);
      assertCounts(await counts(db, fixture), { planned: [3, 0, 0], actual: [2, 0, 0], processed: 2, cursor: 1, status: "finalizing" });
      assert.equal((await finalize(db, fixture, 2)).batch_processed, 1);
      assertCounts(await counts(db, fixture), { planned: [3, 0, 0], actual: [3, 0, 0], processed: 3, cursor: 2 });
      const completed = await counts(db, fixture), written = await products(db, fixture);
      assert.equal(written.length, 3);
      assert.equal((await finalize(db, fixture, 2)).has_more, false);
      assert.deepEqual(await counts(db, fixture), completed);
      assert.deepEqual(await products(db, fixture), written);
    });

    await t.test("mixed inserts, updates and skipped rows stay bounded and finish a trailing skip", async () => {
      const fixture = await seedRun(db, [
        { description: "New product", image: "https://example.invalid/new.jpg" },
        { existing: "Keep", description: "Keep" },
        { existing: "Before", description: "After" },
        { existing: "Trailing", description: "Trailing" },
      ]);
      assert.deepEqual([fixture.validation.insert_count, fixture.validation.update_count, fixture.validation.skip_count], [1, 1, 2]);
      const original = await products(db, fixture);
      for (let index = 0; index < 4; index += 1) {
        const result = await finalize(db, fixture, 1);
        assert.equal(result.batch_processed, 1);
        assert.equal(result.has_more, index < 3);
        assertCounts(await counts(db, fixture), {
          planned: [1, 1, 2], actual: [1, index >= 2 ? 1 : 0, index >= 3 ? 2 : index >= 1 ? 1 : 0],
          processed: index + 1, cursor: index, status: index < 3 ? "finalizing" : "finalized", images: 1,
        });
      }
      const written = await products(db, fixture);
      assert.equal(written.length, 4);
      assert.equal(written.find(row => row.product_code === "COUNTER0").image_url, null, "Image remains quarantined");
      assert.equal(written.find(row => row.product_code === "COUNTER2").description, "After");
      for (const code of ["COUNTER1", "COUNTER3"]) {
        assert.deepEqual(written.find(row => row.product_code === code), original.find(row => row.product_code === code));
      }
      assert.equal((await finalize(db, fixture, 1)).has_more, false);
      assert.deepEqual(await products(db, fixture), written);
    });

    await t.test("insert-only all-skip imports finish without mutating products", async () => {
      const fixture = await seedRun(db, [0, 1, 2].map(() => ({ existing: "Keep", description: "Must not replace" })), "insert_only");
      assert.equal(fixture.validation.skip_count, 3);
      const original = await products(db, fixture);
      assert.equal((await finalize(db, fixture, 2)).batch_processed, 2);
      assertCounts(await counts(db, fixture), { planned: [0, 0, 3], actual: [0, 0, 2], processed: 2, cursor: 1, status: "finalizing" });
      assert.equal((await finalize(db, fixture, 2)).batch_processed, 1);
      assertCounts(await counts(db, fixture), { planned: [0, 0, 3], actual: [0, 0, 3], processed: 3, cursor: 2 });
      assert.deepEqual(await products(db, fixture), original);
    });

    await t.test("untouched timeout recovery keeps the proposed counts", async () => {
      const fixture = await seedRun(db, [{ description: "New product" }, { existing: "Before", description: "After" }, { existing: "Keep", description: "Keep" }]);
      await db.query("UPDATE catalog_import_runs SET status='failed',error_message='statement timeout',finished_at=now() WHERE id=$1", [fixture.run]);
      const result = await finalize(db, fixture, 3);
      assert.equal(result.has_more, false);
      assertCounts(await counts(db, fixture), { planned: [1, 1, 1], actual: [1, 1, 1], processed: 3, cursor: 2 });
    });

    await t.test("unexpected function drift fails closed without overwriting its definition", async () => {
      const fixed = (await db.query("SELECT pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0].definition;
      const drifted = fixed.replace("  v_batch_count integer := 0;", "  v_batch_count integer := 0; -- unreviewed drift");
      assert.notEqual(drifted, fixed);
      await db.exec(drifted);
      const before = (await db.query("SELECT pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0].definition;
      await assert.rejects(db.exec(migration), /CATALOG_FINALIZER_BASELINE_DRIFT/);
      assert.equal((await db.query("SELECT pg_get_functiondef($1::regprocedure) definition", [signature])).rows[0].definition, before);
    });
  } finally {
    await db.close();
  }
});
