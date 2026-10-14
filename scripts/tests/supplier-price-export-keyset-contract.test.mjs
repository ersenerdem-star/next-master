import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../supabase/migrations/20261014072055_supplier_price_export_keyset_page.sql', import.meta.url), 'utf8');

test('supplier export page is tenant and service scoped', () => {
  assert.match(sql, /input_organization_id uuid,\s*\n\s*input_supplier_id uuid,\s*\n\s*input_brand_id uuid/);
  assert.match(sql, /coalesce\(auth\.role\(\), ''\) <> 'service_role'/);
  assert.match(sql, /sp\.organization_id = input_organization_id/);
  assert.match(sql, /sp\.supplier_id = input_supplier_id/);
  assert.match(sql, /sp\.brand_id = input_brand_id/);
  assert.match(sql, /join public\.brands b[\s\S]*?b\.organization_id = input_organization_id/);
});

test('supplier export preserves freshness and supplier fields', () => {
  assert.match(sql, /'all', 'fresh', 'aging', 'stale', 'unknown'/);
  assert.match(sql, /sp\.valid_from >= current_date - interval '90 days'/);
  assert.match(sql, /sp\.valid_from < current_date - interval '180 days'/);
  assert.match(sql, /sp\.order_multiple/);
  assert.match(sql, /sp\.lead_time_days/);
});

test('supplier export uses keyset cursor and emits count only once', () => {
  assert.match(sql, /coalesce\(sp\.product_code, ''\) > coalesce\(input_after_product_code, ''\)/);
  assert.match(sql, /sp\.id > input_after_id/);
  assert.doesNotMatch(sql, /offset\s*\(/i);
  assert.match(sql, /case when input_after_product_code is null then fc\.total_count else null end/);
  assert.match(sql, /revoke all on function public\.cloud_supplier_price_export_page\(uuid, uuid, uuid, text, text, text, uuid, integer\)/);
  assert.match(sql, /create or replace function public\.get_supplier_price_export_version\([\s\S]*?input_brand_id uuid\s*\)/);
  assert.match(sql, /count\(\*\)::text[\s\S]*?max\(sp\.updated_at\)/);
  assert.match(sql, /grant execute on function public\.get_supplier_price_export_version\(uuid, uuid, uuid\)[\s\S]*?to service_role/);
  assert.match(sql, /grant execute on function public\.cloud_supplier_price_export_page\(uuid, uuid, uuid, text, text, text, uuid, integer\)\s+to service_role/);
});
