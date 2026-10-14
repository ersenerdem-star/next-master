import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const md5 = (value) => createHash("md5").update(value).digest("hex");
const qualified = (item) => `${quote(item.schema || "public")}.${quote(item.name)}`;
const signature = (item) => `${item.schema || "public"}.${item.name}(${item.args.split(",").filter(Boolean).map((arg) => arg.trim().replace(/^\w+\s+/, "")).join(",")})`;
const command = { "*": "ALL", r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE" };
const allowedPrivileges = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);
const role = (value) => value === "public" ? "PUBLIC" : quote(value);
const baselineType = (column) => column.type === "aal_level" ? "auth.aal_level" : column.type === "_text" ? "text[]" : column.type;

export function generateFoundationBootstrap(source) {
  if (source.source.projectRef !== "kaxsqafdevabkxofwdod") throw new Error("FOUNDATION_SOURCE_TARGET_MISMATCH");
  if (source.functions.some((fn) => /publish_supplier_price_release_staging|smoke|fixture/i.test(fn.name))) throw new Error("FOUNDATION_TEST_OR_STAGING_RPC_FORBIDDEN");
  const lines = [
    "-- Generated from captured PostgreSQL schema metadata; no business rows or secrets.",
    "-- Production preparation only: this migration has not been applied remotely.",
    "-- Apply FIRST in the reviewed price-engine manifest, before dependent feature migrations.",
    "-- Reproduce with scripts/ops/generate-price-engine-foundation-bootstrap.mjs.",
    `-- Metadata SHA-256: ${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`,
    "-- Legacy anonymous/authenticated TRUNCATE/TRIGGER/REFERENCES grants are intentionally excluded.",
    "BEGIN;", "SET LOCAL search_path = public, extensions, pg_catalog;",
    "DO $foundation_baseline$", "DECLARE required text; BEGIN",
    `  FOREACH required IN ARRAY ARRAY[${source.baselineRelations.map(literal).join(",")}] LOOP`,
    "    IF to_regclass(required) IS NULL THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_RELATION_MISSING: %',required; END IF;",
    "  END LOOP;",
    `  FOREACH required IN ARRAY ARRAY[${source.baselineFunctions.map(literal).join(",")}] LOOP`,
    "    IF to_regprocedure(required) IS NULL THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_MISSING: %',required; END IF;",
    "  END LOOP;", "END $foundation_baseline$;",
    "DO $foundation_storage_rls$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='storage.objects'::regclass AND relrowsecurity) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_STORAGE_RLS_REQUIRED'; END IF; END $foundation_storage_rls$;",
  ];
  for (const column of source.baselineColumns || []) {
    lines.push(`DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(${literal(`${column.schema}.${column.table}`)}) AND a.attname=${literal(column.name)} AND NOT a.attisdropped AND a.atttypid=to_regtype(${literal(baselineType(column))})) THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_BASELINE_COLUMN_DRIFT: ${column.schema}.${column.table}.${column.name}`)}; END IF; END $foundation_baseline_column$;`);
  }
  for (const fn of source.baselineFunctionHashes || []) {
    lines.push(`DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure(${literal(fn.signature)}))) IS DISTINCT FROM ${literal(fn.md5)} THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: ${fn.signature}`)}; END IF; END $foundation_baseline_function$;`);
  }
  for (const schema of source.schemaGrants) {
    lines.push(`CREATE SCHEMA IF NOT EXISTS ${quote(schema.schema)};`,
      `REVOKE ALL ON SCHEMA ${quote(schema.schema)} FROM PUBLIC, anon, authenticated, service_role;`);
  }
  // Create every relation before FKs, %rowtype declarations, policies or indexes.
  for (const table of source.tables) {
    const columns = table.columns.map((column) => {
      const identity = column.identity ? ` GENERATED ${column.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY${column.sequence ? ` (START WITH ${column.sequence.start} INCREMENT BY ${column.sequence.increment} MINVALUE ${column.sequence.min}${column.sequence.max ? ` MAXVALUE ${column.sequence.max}` : ""} CACHE ${column.sequence.cache}${column.sequence.cycle ? " CYCLE" : " NO CYCLE"})` : ""}` : "";
      return `  ${quote(column.name)} ${column.type}${identity}${column.default != null && !identity ? ` DEFAULT ${column.default}` : ""}${column.notNull ? " NOT NULL" : ""}`;
    });
    const constraints = table.constraints.filter((constraint) => constraint.type !== "f").map((constraint) => `  CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`);
    lines.push(`CREATE TABLE IF NOT EXISTS ${qualified(table)} (\n${[...columns, ...constraints].join(",\n")}\n);`);
    lines.push(`REVOKE ALL ON TABLE ${qualified(table)} FROM PUBLIC, anon, authenticated, service_role;`);
    for (const column of table.columns.filter((column) => column.identity)) {
      lines.push(`DO $foundation_sequence$ DECLARE name text; BEGIN name:=pg_get_serial_sequence(${literal(`${table.schema}.${table.name}`)},${literal(column.name)}); EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',name); END $foundation_sequence$;`);
    }
    lines.push(`ALTER TABLE ${qualified(table)} ${table.rls ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY;`);
    lines.push(`ALTER TABLE ${qualified(table)} ${table.forceRls ? "FORCE" : "NO FORCE"} ROW LEVEL SECURITY;`);
  }
  for (const table of source.tables) {
    for (const column of table.columns) {
      lines.push(`DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(${literal(`${table.schema}.${table.name}`)}) AND a.attname=${literal(column.name)} AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)=${literal(column.type)} AND a.attnotnull=${column.notNull} AND a.attidentity=${literal(column.identity || "")}) THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: ${table.schema}.${table.name}.${column.name}`)}; END IF; END $foundation_column$;`);
    }
    for (const constraint of table.constraints) {
      const definition = constraint.definition.replace(/REFERENCES (?!\w+\.)([a-z_]+)\(/g, "REFERENCES public.$1(");
      lines.push(`DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass(${literal(`${table.schema}.${table.name}`)}) AND conname=${literal(constraint.name)}; IF NOT FOUND THEN ALTER TABLE ${qualified(table)} ADD CONSTRAINT ${quote(constraint.name)} ${definition}; ELSIF found_definition<>${literal(constraint.definition)} THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: ${table.schema}.${table.name}.${constraint.name}`)}; END IF; END $foundation_constraint$;`);
    }
  }
  // Private audit/validation bodies precede the public service bridges.
  for (const fn of [...source.functions].sort((a, b) => (a.schema === "public") - (b.schema === "public") || a.name.localeCompare(b.name))) {
    const sig = signature(fn);
    lines.push(`DO $foundation_function$ BEGIN IF to_regprocedure(${literal(sig)}) IS NULL THEN EXECUTE $captured_function$${fn.definition}$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure(${literal(sig)})))<>${literal(md5(fn.definition))} THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: ${sig}`)}; END IF; END $foundation_function$;`);
    lines.push(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated, service_role;`);
    for (const role of ["authenticated", "service_role"]) {
      if (String(fn.grants || "").includes(`${role}=X/`)) lines.push(`GRANT EXECUTE ON FUNCTION ${sig} TO ${role};`);
    }
  }
  for (const table of source.tables) {
    for (const index of table.indexes.filter((index) => !index.constraint)) {
      lines.push(`DO $foundation_index$ BEGIN IF to_regclass(${literal(`${table.schema}.${index.name}`)}) IS NOT NULL AND pg_get_indexdef(to_regclass(${literal(`${table.schema}.${index.name}`)}))<>${literal(index.definition)} THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: ${table.schema}.${index.name}`)}; END IF; END $foundation_index$;`);
      lines.push(`${index.definition.replace(/CREATE (UNIQUE )?INDEX /, "CREATE $1INDEX IF NOT EXISTS ")};`);
    }
    for (const policy of table.policies) {
      lines.push(`DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(${literal(`${table.schema}.${table.name}`)}) AND polname=${literal(policy.name)}) THEN CREATE POLICY ${quote(policy.name)} ON ${qualified(table)} AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${command[policy.command]} TO ${policy.roles.map(role).join(",")}${policy.using ? ` USING (${policy.using})` : ""}${policy.check ? ` WITH CHECK (${policy.check})` : ""}; END IF; END $foundation_policy$;`);
      lines.push(`DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(${literal(`${table.schema}.${table.name}`)}) AND polname=${literal(policy.name)} AND (polcmd<>${literal(policy.command)} OR polpermissive<>${policy.permissive} OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM ${policy.using ? literal(policy.using) : "NULL"} OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM ${policy.check ? literal(policy.check) : "NULL"})) THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: ${table.schema}.${table.name}.${policy.name}`)}; END IF; END $foundation_policy_drift$;`);
    }
    for (const grant of table.grants.filter((grant) => allowedPrivileges.has(grant.privilege))) {
      if (grant.role !== "service_role" && !(grant.role === "authenticated" && grant.privilege === "SELECT")) throw new Error("FOUNDATION_BROWSER_WRITE_GRANT_FORBIDDEN");
      lines.push(`GRANT ${grant.privilege} ON TABLE ${qualified(table)} TO ${quote(grant.role)};`);
    }
  }
  for (const bucket of source.buckets) {
    if (bucket.public) throw new Error("FOUNDATION_PUBLIC_BUCKET_FORBIDDEN");
    lines.push(`INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES (${literal(bucket.id)},${literal(bucket.name)},false,${bucket.fileSizeLimit ?? "NULL"},${bucket.allowedMimeTypes ? `ARRAY[${bucket.allowedMimeTypes.map(literal).join(",")}]::text[]` : "NULL"}) ON CONFLICT(id) DO NOTHING;`);
    lines.push(`DO $foundation_bucket$ BEGIN IF EXISTS (SELECT 1 FROM storage.buckets WHERE id=${literal(bucket.id)} AND (public OR (file_size_limit IS NOT NULL AND file_size_limit<${bucket.fileSizeLimit ?? 33554432}))) THEN RAISE EXCEPTION ${literal(`PRICE_ENGINE_FOUNDATION_BUCKET_DRIFT: ${bucket.id}`)}; END IF; END $foundation_bucket$;`);
  }
  for (const policy of source.storagePolicies) {
    lines.push(`DO $foundation_storage$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname=${literal(policy.name)}) THEN CREATE POLICY ${quote(policy.name)} ON storage.objects AS ${policy.permissive ? "PERMISSIVE" : "RESTRICTIVE"} FOR ${command[policy.command]} TO ${policy.roles.map(role).join(",")}${policy.using ? ` USING (${policy.using})` : ""}${policy.check ? ` WITH CHECK (${policy.check})` : ""}; END IF; END $foundation_storage$;`);
  }
  // Existing permissive Storage policies must never expose prepared artifacts.
  lines.push("DO $foundation_prepared_fence$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_prepared_browser_fence') THEN CREATE POLICY supplier_price_prepared_browser_fence ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated USING (bucket_id<>'supplier-price-prepared') WITH CHECK (bucket_id<>'supplier-price-prepared'); END IF; END $foundation_prepared_fence$;",
    "DO $foundation_upload_anon_fence$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_anon_fence') THEN CREATE POLICY supplier_price_import_objects_anon_fence ON storage.objects AS RESTRICTIVE FOR ALL TO anon USING (bucket_id<>'supplier-price-imports') WITH CHECK (bucket_id<>'supplier-price-imports'); END IF; END $foundation_upload_anon_fence$;",
    "DO $foundation_upload_scope_fence$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_scope_fence') THEN CREATE POLICY supplier_price_import_objects_scope_fence ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated USING (bucket_id<>'supplier-price-imports' OR (split_part(name,'/',1)=public.current_profile_org_id()::text AND public.profile_has_permission('supplier_prices.manage'))) WITH CHECK (bucket_id<>'supplier-price-imports' OR (split_part(name,'/',1)=public.current_profile_org_id()::text AND public.profile_has_permission('supplier_prices.manage'))); END IF; END $foundation_upload_scope_fence$;",
    "COMMIT;", "");
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sourcePath = new URL("../tests/fixtures/price-engine-foundation-source.json", import.meta.url);
  const migrationPath = new URL("../../supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql", import.meta.url);
  const sql = generateFoundationBootstrap(JSON.parse(await readFile(sourcePath, "utf8")));
  if (process.argv.includes("--write")) await writeFile(migrationPath, sql);
  else if (await readFile(migrationPath, "utf8") !== sql) throw new Error("FOUNDATION_GENERATED_MIGRATION_MISMATCH");
  console.log(JSON.stringify({ mode: process.argv.includes("--write") ? "generated-local-migration" : "verified-local-migration", bytes: Buffer.byteLength(sql) }));
}
