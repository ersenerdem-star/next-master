import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync(
  new URL("../../supabase/migrations/20261009120000_supplier_price_release_status_rpc.sql", import.meta.url),
  "utf8",
);

test("release status reconciliation RPC is read-only and service-role only", () => {
  assert.match(sql, /create or replace function public\.get_supplier_price_release_status\(\s*input_release_ids uuid\[\]\s*\)/i);
  assert.match(sql, /returns table \(\s*id uuid,\s*status text\s*\)/i);
  assert.match(sql, /language sql\s+stable\s+security definer/i);
  assert.match(sql, /from public\.supplier_price_releases as r/i);
  assert.match(sql, /revoke all on function public\.get_supplier_price_release_status\(uuid\[\]\)[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant execute on function public\.get_supplier_price_release_status\(uuid\[\]\)[\s\S]*to service_role/i);
});
