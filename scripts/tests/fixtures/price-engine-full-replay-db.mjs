import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";

export const fullReplaySource = JSON.parse(await readFile(new URL("./price-engine-full-replay-production-source.json",import.meta.url),"utf8"));
const externalColumns = JSON.parse(await readFile(new URL("./price-engine-production-baseline.json",import.meta.url),"utf8"));
const quote = (value)=>`"${String(value).replaceAll('"','""')}"`;
const literal = (value)=>`'${String(value).replaceAll("'","''")}'`;
const qualified = (schema,name)=>`${quote(schema)}.${quote(name)}`;
const command={r:"SELECT",a:"INSERT",w:"UPDATE",d:"DELETE","*":"ALL"};
const privilege={a:"INSERT",r:"SELECT",w:"UPDATE",d:"DELETE",D:"TRUNCATE",x:"REFERENCES",t:"TRIGGER",m:"MAINTAIN",X:"EXECUTE"};
function columnType(column) { return column.type==="aal_level"?"auth.aal_level":column.type==="_text"?"text[]":column.type; }
function acl(grants) {
  return [...String(grants||"").replace(/^\{|\}$/g,"").matchAll(/(?:^|,)([^=,]*)=([A-Za-z*]+)\/[^,]*/g)]
    .map((match)=>({role:match[1]||"public",privileges:[...match[2]].filter((letter)=>privilege[letter]).map((letter)=>privilege[letter])}));
}
function functionSignature(fn) {
  return `${qualified(fn.schema,fn.name)}(${fn.args.split(",").filter(Boolean).map((arg)=>{
    const trimmed=arg.trim();
    // pg_get_function_identity_arguments omits names for C extension functions.
    return fn.definition.includes("LANGUAGE c")?trimmed:trimmed.replace(/^\w+\s+/,"");
  }).join(",")})`;
}

export async function createFullReplayDb() {
  const db=new PGlite({extensions:{unaccent,pgcrypto,pg_trgm}});
  try {
    await db.exec("CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA extensions; SET search_path=public,extensions,pg_catalog; SET check_function_bodies=false");
    for(const item of fullReplaySource.roles) await db.exec(`CREATE ROLE ${quote(item.name)} ${item.bypassRls?"BYPASSRLS":"NOBYPASSRLS"}`);
    for(const item of fullReplaySource.enumTypes) await db.exec(`CREATE TYPE ${qualified(item.schema,item.name)} AS ENUM(${item.values.map(literal).join(",")})`);
    for(const item of fullReplaySource.extensions) await db.exec(`CREATE EXTENSION ${quote(item.name)} WITH SCHEMA ${quote(item.schema)}`);
    for(const fn of fullReplaySource.externalFunctions) await db.exec(fn.definition);
    // External Supabase Auth/Storage columns are the captured production types.
    // No authentication function is replaced with a synthetic implementation.
    for(const [key,cols] of Map.groupBy(externalColumns.columns.filter((column)=>column.schema!=="public"),(column)=>`${column.schema}.${column.table}`)) {
      await db.exec(`CREATE TABLE ${key}(${cols.map((column)=>`${quote(column.name)} ${columnType(column)}`).join(",")},PRIMARY KEY(id))`);
    }
    const bucketColumns=fullReplaySource.storageBucket.columns.map((column)=>`${quote(column.name)} ${column.type}${column.default?` DEFAULT ${column.default}`:""}${column.notNull?" NOT NULL":""}`);
    const bucketConstraints=fullReplaySource.storageBucket.constraints.map((constraint)=>`CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`);
    await db.exec(`CREATE TABLE storage.buckets(${[...bucketColumns,...bucketConstraints].join(",")});ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY`);
    for(const bucket of fullReplaySource.bucketConfiguration) await db.query("INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES($1,$2,$3,$4,$5)",[bucket.id,bucket.name,bucket.public,bucket.file_size_limit,bucket.allowed_mime_types]);
    const expressionFunctions=new Set();
    for(const table of fullReplaySource.tables) for(const column of table.columns) {
      for(const fn of fullReplaySource.functions) if(new RegExp(`\\b${fn.name}\\s*\\(`,"i").test(column.expression||"")) expressionFunctions.add(fn.name);
    }
    for(const fn of fullReplaySource.functions.filter((fn)=>expressionFunctions.has(fn.name))) await db.exec(fn.definition);
    for(const table of fullReplaySource.tables) {
      if(table.kind!=="r") throw new Error(`FULL_REPLAY_VIEW_ORDER_REQUIRED:${table.name}`);
      const columns=table.columns.map((column)=>`${quote(column.name)} ${column.type}${column.generated?` GENERATED ALWAYS AS(${column.expression}) STORED`:column.expression?` DEFAULT ${column.expression}`:""}${column.notNull?" NOT NULL":""}`);
      const keys=table.constraints.filter((constraint)=>["p","u"].includes(constraint.type)).map((constraint)=>`CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`);
      await db.exec(`CREATE TABLE ${qualified(table.schema,table.name)}(${[...columns,...keys].join(",")})`);
    }
    for(const fn of fullReplaySource.functions) await db.exec(fn.definition);
    // Composite FK targets can be backed by a captured UNIQUE index rather
    // than a pg_constraint entry. Install all indexes before any foreign key.
    for(const table of fullReplaySource.tables) for(const index of table.indexes.filter((index)=>!index.constraint)) await db.exec(index.definition);
    for(const table of fullReplaySource.tables) {
      for(const constraint of table.constraints.filter((constraint)=>!["p","u"].includes(constraint.type))) {
        await db.exec(`ALTER TABLE ${qualified(table.schema,table.name)} ADD CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`);
      }
      for(const policy of table.policies) await db.exec(`CREATE POLICY ${quote(policy.name)} ON ${qualified(table.schema,table.name)} AS ${policy.permissive?"PERMISSIVE":"RESTRICTIVE"} FOR ${command[policy.command]} TO ${policy.roles.map((role)=>role==="public"?"PUBLIC":quote(role)).join(",")}${policy.using?` USING(${policy.using})`:""}${policy.check?` WITH CHECK(${policy.check})`:""}`);
      for(const trigger of table.triggers) await db.exec(trigger.definition);
      await db.exec(`ALTER TABLE ${qualified(table.schema,table.name)} ${table.rls?"ENABLE":"DISABLE"} ROW LEVEL SECURITY;ALTER TABLE ${qualified(table.schema,table.name)} ${table.forceRls?"FORCE":"NO FORCE"} ROW LEVEL SECURITY`);
      await db.exec(`REVOKE ALL ON TABLE ${qualified(table.schema,table.name)} FROM PUBLIC,anon,authenticated,service_role`);
      for(const grant of acl(table.grants)) if(grant.privileges.length) await db.exec(`GRANT ${grant.privileges.join(",")} ON TABLE ${qualified(table.schema,table.name)} TO ${grant.role==="public"?"PUBLIC":quote(grant.role)}`);
    }
    for(const fn of fullReplaySource.functions) if(fn.grants!==null) {
      const signature=functionSignature(fn);
      await db.exec(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC,anon,authenticated,service_role`);
      for(const grant of acl(fn.grants)) if(grant.privileges.includes("EXECUTE")) await db.exec(`GRANT EXECUTE ON FUNCTION ${signature} TO ${grant.role==="public"?"PUBLIC":quote(grant.role)}`);
    }
    for(const grant of acl(fullReplaySource.storageObject.grants)) if(grant.privileges.length) await db.exec(`GRANT ${grant.privileges.join(",")} ON TABLE storage.objects TO ${grant.role==="public"?"PUBLIC":quote(grant.role)}`);
    for(const policy of fullReplaySource.storageObject.policies) await db.exec(`CREATE POLICY ${quote(policy.name)} ON storage.objects AS ${policy.permissive?"PERMISSIVE":"RESTRICTIVE"} FOR ${command[policy.command]} TO ${policy.roles.map((role)=>role==="public"?"PUBLIC":quote(role)).join(",")}${policy.using?` USING(${policy.using})`:""}${policy.check?` WITH CHECK(${policy.check})`:""}`);
    await db.exec("SET check_function_bodies=true; GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role");
    return db;
  } catch(error) { await db.close(); throw new Error(`${error.code||"BASELINE"}: ${error.message}`); }
}
