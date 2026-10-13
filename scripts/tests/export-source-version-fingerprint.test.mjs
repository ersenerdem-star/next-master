import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../supabase/migrations/20261013140014_supplier_price_export_complete_source_fingerprint.sql', import.meta.url), 'utf8');

test('export version tracks all scoped row sources and replacement transitions', () => {
  assert.match(sql, /count\(\*\)::text\s*\|\|\s*':'\s*\|\|[\s\S]*?max\(spr\.refreshed_at\)/);
  assert.match(sql, /count\(\*\)::text\s*\|\|\s*':'\s*\|\|[\s\S]*?max\(cp\.updated_at\)/);
  assert.match(sql, /from public\.supplier_current_price_pointers ptr[\s\S]*?pub\.status='published'/);
  assert.match(sql, /jsonb_agg\([\s\S]*?ref\.id, ref\.old_code, ref\.new_code, ref\.is_active,[\s\S]*?ref\.updated_at[\s\S]*?order by ref\.id/);
  assert.match(sql, /from public\.item_code_references ref\s+where ref\.organization_id=input_organization_id\s+and ref\.brand_id=input_brand_id/);
  assert.match(sql, /revoke all on function public\.get_admin_price_list_export_version\(uuid,uuid\)\s+from public,anon,authenticated/);
  assert.match(sql, /grant execute on function public\.get_admin_price_list_export_version\(uuid,uuid\)\s+to service_role/);
});
