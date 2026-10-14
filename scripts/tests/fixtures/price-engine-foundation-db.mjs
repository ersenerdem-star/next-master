import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const baseline = JSON.parse(await readFile(new URL("./price-engine-production-baseline.json", import.meta.url), "utf8"));
const quote = (value) => `"${value.replaceAll('"','""')}"`;
const type = (column) => column.type === "aal_level" ? "auth.aal_level" : column.type === "_text" ? "text[]" : column.type;
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;

// Prerequisite columns and helper bodies come from production metadata.
// Tests apply the complete real foundation migration after this baseline.
export async function createFoundationTestDb() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions;
    CREATE TYPE auth.aal_level AS ENUM ('aal1','aal2','aal3');
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('request.jwt.claim.role',true),'')$$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;`);
  const groups = Map.groupBy(baseline.columns, (column) => `${column.schema}.${column.table}`);
  for (const [name, columns] of groups) {
    const primary = columns.some((column) => column.name === "id") ? ",PRIMARY KEY(id)" : "";
    await db.exec(`CREATE TABLE ${name} (${columns.map((column) => `${quote(column.name)} ${type(column)}`).join(",")}${primary});`);
  }
  for (const table of baseline.additionalTables) {
    await db.exec(`CREATE TABLE public.${quote(table.name)} (${table.columns.map((column) => `${quote(column.name)} ${column.type}`).join(",")}, ${table.constraints.find((constraint)=>constraint.type==='p').definition});`);
  }
  await db.exec(`CREATE TABLE storage.buckets (${baseline.buckets.map((column) => `${quote(column.name)} ${column.type}`).join(",")}, PRIMARY KEY(id));
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;
    GRANT SELECT ON public.profiles TO authenticated;
    CREATE POLICY fixture_broad_storage ON storage.objects TO anon,authenticated USING(true) WITH CHECK(true);`);
  for (const fn of [...baseline.dependencyFunctions,...baseline.functions]) await db.exec(fn.definition);
  return db;
}

export async function seedFoundationTestScope(db) {
  await db.query("INSERT INTO public.organizations(id,name) VALUES ($1,'Org'),($2,'Other')",[id(1),id(2)]);
  await db.query("INSERT INTO public.suppliers(id,organization_id,name) VALUES ($1,$2,'Supplier'),($3,$4,'Other')",[id(3),id(1),id(4),id(2)]);
  await db.query("INSERT INTO public.brands(id,organization_id,name) VALUES ($1,$2,'Brand'),($3,$4,'Other')",[id(5),id(1),id(6),id(2)]);
  await db.query("INSERT INTO public.profiles(id,organization_id,role,is_active,permissions) VALUES ($1,$2,'superadmin',true,$3)",[id(7),id(1),{"supplier_prices.manage":true}]);
  await db.query("INSERT INTO auth.users(id) VALUES ($1)",[id(7)]);
  await db.query("INSERT INTO auth.sessions(id,user_id,not_after) VALUES ($1,$2,now()+interval '1 day')",[id(8),id(7)]);
  await db.exec("SELECT set_config('request.jwt.claim.role','service_role',false)");
}

export async function executeFixtureMigration(db, sql) {
  try { return await db.exec(sql); }
  catch (error) { throw new Error(`${error.code}: ${error.message}`); }
}
