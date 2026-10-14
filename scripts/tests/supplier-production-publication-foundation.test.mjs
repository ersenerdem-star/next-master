import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFoundationTestDb, seedFoundationTestScope, executeFixtureMigration } from "./fixtures/price-engine-foundation-db.mjs";

const foundation = await readFile(new URL("../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql",import.meta.url),"utf8");
const publication = await readFile(new URL("../../supabase/migrations/20261014110614_supplier_price_production_publication_decision.sql",import.meta.url),"utf8");
const id=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const org=id(1),supplier=id(3),brand=id(5),actor=id(7);

async function setup() {
  const db=await createFoundationTestDb();
  await executeFixtureMigration(db,foundation);
  await executeFixtureMigration(db,publication);
  await seedFoundationTestScope(db);
  assert.deepEqual((await db.query("SELECT enabled,reversal_enabled FROM supplier_price_ingestion_internal.production_publication_control")).rows[0],{enabled:false,reversal_enabled:false});
  await db.query("UPDATE supplier_price_ingestion_internal.production_publication_control SET enabled=true,reversal_enabled=true,activation_decision_id=$1,activated_by=$2,activated_at=now()",[id(99),actor]);
  return db;
}

async function seedRelease(db,releaseId,{prefix="CLEAR",rows=2,revision=0}={}) {
  await db.query(`INSERT INTO public.supplier_price_releases(
    id,organization_id,supplier_id,brand_id,status,validated_at,total_rows,accepted_rows,processed_rows,current_cursor,
    rejected_rows,warning_rows,conflict_rows,source_verification_required,uploaded_at,source_file_path,source_file_sha256,
    review_revision,brand_identity_audit,created_by) VALUES($1,$2,$3,$4,'validated',now(),$5,$5,$5,$5,0,0,0,true,now(),$6,$7,$8,$9,$10)`,
    [releaseId,org,supplier,brand,rows,`fixture/${releaseId}.csv`,createHash('sha256').update(`${releaseId}:${prefix}:${rows}`).digest('hex'),revision,{policy:"cross-brand-v1",checked:true,review_required:false},actor]);
  await db.query(`INSERT INTO public.supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,row_status)
    SELECT $1,i,$2||i::text,$2||i::text,12.34,'EUR','accepted' FROM generate_series(1,$3::int) i`,[releaseId,prefix,rows]);
}

async function publish(db,releaseId,decisionId,{revision=0,previous=null}={}) {
  return (await db.query("SELECT public.publish_supplier_price_release_production($1,$2,$3,$4,$5,$6,$7,$8,$9) receipt",
    ["zjgueqijumzlfioihnkt",releaseId,org,supplier,brand,actor,decisionId,revision,previous])).rows[0].receipt;
}

async function reverse(db,targetDecision,currentId,{decision=id(30),revision=null}={}) {
  return (await db.query("SELECT public.reverse_supplier_price_publication_production($1,$2,$3,$4,$5,$6,$7,$8,$9) receipt",
    ["zjgueqijumzlfioihnkt",org,supplier,brand,actor,decision,targetDecision,currentId,revision])).rows[0].receipt;
}

async function state(db) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM public.supplier_price_publications) publications,
    (SELECT count(*)::int FROM supplier_price_ingestion_internal.production_publication_decisions) decisions,
    (SELECT count(*)::int FROM supplier_price_ingestion_internal.production_publication_reversals) reversals,
    (SELECT count(*)::int FROM public.supplier_price_release_events) events`)).rows[0];
}

test("real foundation identity audit permits first publication and exact reversal/replay preserves the ledger",async()=>{
  const db=await setup();
  try {
    const release=id(10),decision=id(20);
    await seedRelease(db,release);
    await db.exec("SET ROLE service_role");
    const published=await publish(db,release,decision);
    assert.equal(published.published,true);
    assert.equal(published.is_current,true);
    assert.deepEqual(await publish(db,release,decision),{...published,replayed:true});
    await db.exec("RESET ROLE");
    const ledger=(await db.query("SELECT identity_audit FROM supplier_price_ingestion_internal.production_publication_decisions WHERE decision_id=$1",[decision])).rows[0].identity_audit;
    assert.equal(ledger.policy,"cross-brand-v1");
    assert.equal(ledger.checked,true);
    assert.equal(ledger.distinct_incoming_codes,2);
    assert.equal(ledger.matching_brand_count,0);
    assert.equal(ledger.selected_brand_id,brand);
    assert.equal(ledger.review_required,false);
    assert.ok(ledger.checked_at); // Added by the captured real cross_brand_audit.
    const reversed=await reverse(db,decision,published.publication_id);
    assert.equal(reversed.reversed,true);
    assert.equal(reversed.restored_publication_id,null);
    assert.equal((await db.query("SELECT count(*)::int n FROM supplier_current_price_pointers")).rows[0].n,0);
    assert.deepEqual(await reverse(db,decision,published.publication_id),{...reversed,replayed:true});
    assert.deepEqual(await state(db),{publications:1,decisions:1,reversals:1,events:2});
    assert.deepEqual((await db.query("SELECT r.status release_status,p.status publication_status FROM supplier_price_releases r JOIN supplier_price_publications p ON p.release_id=r.id WHERE r.id=$1",[release])).rows[0],{release_status:"archived",publication_status:"rolled_back"});
  } finally { await db.close(); }
});

test("real helper rechecks the previous release during CAS publication and restoration",async()=>{
  const db=await setup();
  try {
    const firstRelease=id(10),nextRelease=id(11),firstDecision=id(20),nextDecision=id(21);
    await seedRelease(db,firstRelease,{revision:2});
    await seedRelease(db,nextRelease,{revision:3,prefix:"NEXT"});
    await assert.rejects(publish(db,firstRelease,firstDecision),/STALE_REVIEW/);
    const first=await publish(db,firstRelease,firstDecision,{revision:2});
    await assert.rejects(publish(db,nextRelease,nextDecision,{revision:3}),/STALE_POINTER/);
    const next=await publish(db,nextRelease,nextDecision,{revision:3,previous:first.publication_id});
    const oldReplay=await publish(db,firstRelease,firstDecision,{revision:2});
    assert.equal(oldReplay.replayed,true);
    assert.equal(oldReplay.is_current,false);
    await assert.rejects(reverse(db,nextDecision,next.publication_id,{revision:1}),/STALE_REVIEW/);
    const restored=await reverse(db,nextDecision,next.publication_id,{revision:2});
    assert.equal(restored.restored_release_id,firstRelease);
    assert.equal(restored.restored_publication_id,first.publication_id);
    assert.deepEqual((await db.query("SELECT release_id,publication_id FROM supplier_current_price_pointers")).rows[0],{release_id:firstRelease,publication_id:first.publication_id});
    const audit=(await db.query("SELECT restored_identity_audit FROM supplier_price_ingestion_internal.production_publication_reversals")).rows[0].restored_identity_audit;
    assert.equal(audit.checked,true);
    assert.equal(audit.distinct_incoming_codes,2);
    assert.equal(audit.review_required,false);
    assert.deepEqual(await state(db),{publications:2,decisions:2,reversals:1,events:3});
  } finally { await db.close(); }
});

test("actual catalog and legacy price overlap defeats stale green audit without changing the current pointer",async()=>{
  const db=await setup();
  try {
    const firstRelease=id(10),blockedRelease=id(11),otherBrand=id(12);
    await seedRelease(db,firstRelease);
    const first=await publish(db,firstRelease,id(20));
    await seedRelease(db,blockedRelease,{prefix:"OVERLAP",rows:100});
    await db.query("INSERT INTO brands(id,organization_id,name) VALUES($1,$2,'Different brand')",[otherBrand,org]);
    await db.query(`INSERT INTO catalog_products(id,organization_id,brand_id,product_code,normalized_code)
      SELECT md5('catalog-overlap-'||i)::uuid,$1,$2,'OVERLAP'||i,'OVERLAP'||i FROM generate_series(1,100) i`,[org,otherBrand]);
    await db.query(`INSERT INTO supplier_prices(id,organization_id,supplier_id,brand_id,product_code,normalized_code,is_active,buy_price,currency)
      SELECT md5('legacy-overlap-'||i)::uuid,$1,$2,$3,'OVERLAP'||i,'OVERLAP'||i,true,99,'EUR' FROM generate_series(1,100) i`,[org,supplier,otherBrand]);
    const held=await publish(db,blockedRelease,id(21),{previous:first.publication_id});
    assert.equal(held.status,"review_required");
    assert.equal(held.published,false);
    assert.equal(held.error_code,"CROSS_BRAND_BULK_OVERLAP");
    assert.deepEqual((await db.query("SELECT publication_id,release_id FROM supplier_current_price_pointers")).rows[0],{publication_id:first.publication_id,release_id:firstRelease});
    const release=(await db.query("SELECT error_code,brand_identity_audit FROM supplier_price_releases WHERE id=$1",[blockedRelease])).rows[0];
    assert.equal(release.error_code,"CROSS_BRAND_BULK_OVERLAP");
    assert.equal(release.brand_identity_audit.checked,true);
    assert.equal(release.brand_identity_audit.review_required,true);
    assert.equal(release.brand_identity_audit.distinct_incoming_codes,100);
    assert.equal(release.brand_identity_audit.matching_brand_count,1);
    assert.equal(release.brand_identity_audit.brands[0].brand_id,otherBrand);
    assert.equal(release.brand_identity_audit.brands[0].matching_codes,100); // UNION prevents catalog+legacy double counting.
    assert.equal(release.brand_identity_audit.brands[0].incoming_percent,100);
    assert.deepEqual(await state(db),{publications:1,decisions:1,reversals:0,events:2});
  } finally { await db.close(); }
});
