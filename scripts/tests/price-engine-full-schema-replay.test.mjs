import assert from "node:assert/strict";
import { readFile,writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFullReplayDb,fullReplaySource } from "./fixtures/price-engine-full-replay-db.mjs";

const manifestPath=new URL("../ops/price-engine-production-manifest.json",import.meta.url);
const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
const forwardReplayFiles=[
  "supabase/migrations/20261014145352_supplier_price_export_compact_search_index.sql",
  "supabase/migrations/20261014144957_supplier_price_workflow_failure_visibility.sql",
];
const forwardReplay=forwardReplayFiles.map(file=>{
  const matches=manifest.migration_order.filter(entry=>entry.file===file);
  assert.equal(matches.length,1,`Missing/duplicate reviewed forward:${file}`);
  return matches[0];
});
const repoRoot=new URL("../../",import.meta.url);
const fixtureOrg="90000000-0000-4000-8000-000000000001";
const fixtureJob="90000000-0000-4000-8000-000000000002";
const fixtureObject="90000000-0000-4000-8000-000000000003";
const fixturePositiveObject="90000000-0000-4000-8000-000000000004";
const logicalSchemaSql=`SELECT jsonb_build_object(
  'columns',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY n.nspname,c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'),
  'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prokind='f'),
  'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid,true)) ORDER BY n.nspname,c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'),
  'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY n.nspname,ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace n ON n.oid=ic.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'),
  'policies',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r) END FROM unnest(p.polroles) r),pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY n.nspname,c.relname,p.polname) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace),
  'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid,true) ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal),
  'rls',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind='r')
) AS schema_metadata`;

async function seedPreexistingJob(db) {
  await db.query("INSERT INTO organizations(id,name) VALUES($1,'Synthetic replay organization')",[fixtureOrg]);
  await db.query(`INSERT INTO app_export_jobs(id,organization_id,audience,export_type,status,scope,cache_key,data_version,file_name,content_type,storage_bucket,storage_path,row_count,byte_size,progress_total,progress_done,progress_message,started_at,finalized_at,expires_at,created_at,updated_at)
    VALUES($1,$2,'admin','catalog_export','finalized',$3,'existing-job-cache','original-data-version','existing.csv','text/csv','app-exports','synthetic/existing.csv',3,47,3,3,'Existing completed job','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z','2030-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z')`,[fixtureJob,fixtureOrg,{format:"csv",source:"synthetic-existing-job",nested:{preserve:true}}]);
  return (await db.query("SELECT to_jsonb(j) row FROM app_export_jobs j WHERE id=$1",[fixtureJob])).rows[0].row;
}

async function assertRoleBoundaries(db) {
  assert.deepEqual((await db.query("SELECT enabled,reversal_enabled FROM supplier_price_ingestion_internal.production_publication_control")).rows[0],{enabled:false,reversal_enabled:false});
  for(const who of ["anon","authenticated"]) {
    assert.deepEqual((await db.query("SELECT has_function_privilege($1,'public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)','EXECUTE') publish,has_table_privilege($1,'supplier_price_ingestion_internal.production_publication_control','UPDATE') activation,has_schema_privilege($1,'supplier_price_ingestion_internal','USAGE') private_schema",[who])).rows[0],{publish:false,activation:false,private_schema:false});
  }
  const fence=(await db.query("SELECT polcmd::text cmd,polpermissive permissive FROM pg_policy WHERE polname='supplier_price_prepared_browser_fence' AND polrelid='storage.objects'::regclass")).rows[0];
  assert.deepEqual(fence,{cmd:"*",permissive:false});
  const bucket=(await db.query("SELECT public,file_size_limit::text limit_bytes,allowed_mime_types FROM storage.buckets WHERE id='app-exports'")).rows[0];
  assert.equal(bucket.public,false);
  assert.equal(bucket.limit_bytes,String(fullReplaySource.bucketConfiguration[0].file_size_limit));
  assert.deepEqual(bucket.allowed_mime_types,[...fullReplaySource.bucketConfiguration[0].allowed_mime_types,"application/octet-stream"]);
}

test("fresh62 chain applies to the captured production schema, then its two new forwards replay without schema drift",async()=>{
  assert.equal(manifest.migration_order.length,62);
  const db=await createFullReplayDb();
  const evidence={evidence_scope:"Local isolated PG17 schema replay; actual production schema metadata; no remote writes or commercial browser proof",source_project_ref:fullReplaySource.source.projectRef,manifest_sha256:createHash("sha256").update(await readFile(manifestPath)).digest("hex"),baseline_tables:fullReplaySource.tables.length,baseline_functions:fullReplaySource.functions.length,
    replay_policy:"Fresh complete 62-entry chain, then only the two new forward migrations. Historical foundation bytes and MD5 guards are preserved; replaying foundation over the forward-replaced upload-status function is intentionally excluded. Prior 60+60 evidence remains in Git history, not claimed by this run.",passes:[],remote_mutations:0};
  try {
    const originalJob=await seedPreexistingJob(db);
    const fingerprints=[];
    for(let pass=1;pass<=2;pass++) {
      const entries=pass===1?manifest.migration_order:forwardReplay;
      const completed=[];
      for(const entry of entries) {
        const bytes=await readFile(new URL(entry.file,repoRoot));
        assert.equal(createHash("sha256").update(bytes).digest("hex"),entry.sha256,`Manifest drift:${entry.file}`);
        try { await db.exec(bytes.toString("utf8")); }
        catch(error) {
          evidence.failed={pass,completed:completed.length,file:entry.file,code:error.code,message:error.message,where:error.where||null,internal_query:error.internalQuery||null,position:error.position||null};
          await writeFile(new URL("../ops/evidence/price-engine-full-schema-replay-local.json",import.meta.url),JSON.stringify(evidence,null,2)+"\n");
          throw new Error(`FULL_SCHEMA_REPLAY_PASS_${pass}_${completed.length}/${entries.length}:${entry.file}:${error.code}:${error.message}`);
        }
        completed.push({file:entry.file,sha256:entry.sha256});
      }
      const job=(await db.query("SELECT to_jsonb(j) row FROM app_export_jobs j WHERE id=$1",[fixtureJob])).rows[0].row;
      for(const [field,value] of Object.entries(originalJob)) assert.deepEqual(job[field],value,`Existing job mutated:${field}:pass${pass}`);
      await assertRoleBoundaries(db);
      const schema=(await db.query(logicalSchemaSql)).rows[0].schema_metadata;
      const fingerprint=createHash("sha256").update(JSON.stringify(schema)).digest("hex");
      fingerprints.push(fingerprint);
      evidence.passes.push({pass,scope:pass===1?"fresh-complete-manifest":"new-forward-migrations-only",migrations:completed,logical_schema_sha256:fingerprint,preexisting_job_business_fields_preserved:true,production_activation_off:true,role_boundaries_preserved:true});
    }
    assert.equal(evidence.passes.length,2);
    assert.equal(evidence.passes[0].migrations.length,manifest.migration_order.length);
    assert.equal(evidence.passes[1].migrations.length,forwardReplay.length);
    assert.equal(fingerprints[0],fingerprints[1],"Replaying the two forwards changed the logical schema");
    // Test-only adversarial challenge, AFTER both migration fingerprints and
    // actual role-boundary assertions. A broad permissive policy must not
    // reopen prepared artifacts; a nonprepared object is the positive control.
    await db.exec("GRANT SELECT,INSERT ON storage.objects TO anon,authenticated;CREATE POLICY replay_test_only_permissive_challenge ON storage.objects TO anon,authenticated USING(true) WITH CHECK(true)");
    await db.query("INSERT INTO storage.buckets(id,name,public) VALUES('replay-test-only-positive','replay-test-only-positive',false)");
    await db.query("INSERT INTO storage.objects(id,bucket_id,name) VALUES($1,'supplier-price-prepared','synthetic-prepared.csv')",[fixtureObject]);
    await db.query("INSERT INTO storage.objects(id,bucket_id,name) VALUES($1,'replay-test-only-positive','synthetic-positive.csv')",[fixturePositiveObject]);
    for(const who of ["anon","authenticated"]) {
      await db.exec(`SET ROLE ${who}`);
      assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='replay-test-only-positive'")).rows[0].n,1,`Positive Storage control inaccessible:${who}`);
      assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='supplier-price-prepared'")).rows[0].n,0);
      await assert.rejects(db.query("INSERT INTO storage.objects(id,bucket_id,name) VALUES($1,'supplier-price-prepared','unauthorized.csv')",[fixtureJob]),/row-level security/);
      await assert.rejects(db.query("SELECT public.publish_supplier_price_release_production('zjgueqijumzlfioihnkt',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)"),/permission denied/);
      await db.exec("RESET ROLE");
    }
    evidence.prepared_artifact_read_write_denied_for_browser_roles=true;
    evidence.prepared_fence_adversarial_permissive_policy_positive_control="passed after both migration fingerprints; synthetic test-only grants/policy/object";
    evidence.status="passed";
    await writeFile(new URL("../ops/evidence/price-engine-full-schema-replay-local.json",import.meta.url),JSON.stringify(evidence,null,2)+"\n");
  } finally { await db.close(); }
});
