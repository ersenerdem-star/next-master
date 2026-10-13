import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const connectionString = process.env.LEGACY_SUPPLIER_PRICE_GUARD_TEST_DATABASE_URL;
const migration = await readFile(
  new URL("../../supabase/migrations/20261013140013_supplier_price_block_legacy_published_writes.sql", import.meta.url),
  "utf8",
);
const deleteGuardMigration = await readFile(
  new URL("../../supabase/migrations/20261013140015_supplier_price_guard_active_legacy_delete.sql", import.meta.url),
  "utf8",
);

test("published V3 brands reject legacy price writes while other scopes and retention stay writable", {
  skip: !connectionString && "Set LEGACY_SUPPLIER_PRICE_GUARD_TEST_DATABASE_URL to a disposable local PostgreSQL database",
}, async () => {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.equal(url.pathname, "/legacy_guard_test");

  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("begin");

  const orgA = "00000000-0000-0000-0000-000000000001";
  const orgB = "00000000-0000-0000-0000-000000000002";
  const brandA = "10000000-0000-0000-0000-000000000001";
  const brandB = "10000000-0000-0000-0000-000000000002";
  const brandOtherOrg = "10000000-0000-0000-0000-000000000003";
  const supplier = "20000000-0000-0000-0000-000000000001";

  async function rejected(sql, params = []) {
    await client.query("savepoint expected_rejection");
    try {
      await assert.rejects(client.query(sql, params), /LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED/);
    } finally {
      await client.query("rollback to savepoint expected_rejection");
      await client.query("release savepoint expected_rejection");
    }
  }

  try {
    await client.query(`
      create role anon;
      create role authenticated;
      create schema if not exists auth;
      create function public.current_profile_org_id() returns uuid language sql stable
        as $$select current_setting('test.org')::uuid$$;
      create function public.current_profile_role() returns text language sql stable
        as $$select 'admin'::text$$;
      create function public.is_superadmin() returns boolean language sql stable
        as $$select true$$;
      create function public.normalize_part_code(input_code text) returns text language sql immutable
        as $$select upper(regexp_replace(coalesce(input_code, ''), '[^A-Za-z0-9]', '', 'g'))$$;
      create function public.close_stale_supplier_price_import_runs(input_age interval)
        returns void language plpgsql as $$begin null; end$$;
      create function public.begin_supplier_price_import_inner(text, text, text)
        returns jsonb language sql as $$select '{"run_id":"allowed"}'::jsonb$$;
      create function public.bulk_import_supplier_prices_inner(jsonb)
        returns jsonb language sql as $$select '{"processed":1}'::jsonb$$;
      create table public.brands (
        id uuid primary key, organization_id uuid not null, name text,
        normalized_name text not null
      );
      create table public.suppliers (
        id uuid primary key, organization_id uuid not null, normalized_name text not null
      );
      create table public.supplier_current_price_pointers (
        organization_id uuid not null, brand_id uuid not null
      );
      create table public.supplier_prices (
        id integer generated always as identity primary key,
        organization_id uuid not null, supplier_id uuid not null, brand_id uuid not null,
        product_code text, normalized_code text, description text,
        buy_price numeric, currency text, valid_from date, valid_to date,
        is_active boolean, moq integer, order_multiple integer, lead_time_days integer
      );
    `);
    await client.query(
      "insert into public.brands(id,organization_id,name,normalized_name) values ($1,$4,'A','A'),($2,$4,'B','B'),($3,$5,'A','A')",
      [brandA, brandB, brandOtherOrg, orgA, orgB],
    );
    await client.query(
      "insert into public.supplier_prices(organization_id,supplier_id,brand_id,product_code,buy_price,is_active) values ($1,$2,$3,'OLD',10,true),($1,$2,$3,'INACTIVE',10,false)",
      [orgA, supplier, brandA],
    );
    await client.query(
      "insert into public.supplier_current_price_pointers(organization_id,brand_id) values ($1,$2)",
      [orgA, brandA],
    );
    await client.query(migration);
    await client.query(deleteGuardMigration);
    await client.query("select set_config('test.org', $1, true)", [orgA]);

    await rejected("select public.assert_legacy_supplier_price_write_allowed('A')");
    await rejected("select public.begin_supplier_price_import('Supplier','A','replace')");
    await rejected("select public.bulk_import_supplier_prices('[{\"brand\":\"A\"}]'::jsonb)");
    await rejected(
      "insert into public.supplier_prices(organization_id,supplier_id,brand_id,product_code,buy_price) values ($1,$2,$3,'NEW',20)",
      [orgA, supplier, brandA],
    );
    await rejected("update public.supplier_prices set buy_price=11 where brand_id=$1", [brandA]);
    await rejected("update public.supplier_prices set brand_id=$1 where brand_id=$2", [brandB, brandA]);

    const allowed = await client.query("select public.assert_legacy_supplier_price_write_allowed('B') as writable");
    assert.equal(allowed.rows[0].writable, true);
    await client.query("select public.begin_supplier_price_import('Supplier','B','replace')");
    await client.query("select public.bulk_import_supplier_prices('[{\"brand\":\"B\"}]'::jsonb)");
    await client.query(
      "insert into public.supplier_prices(organization_id,supplier_id,brand_id,product_code,buy_price) values ($1,$2,$3,'NEW',20)",
      [orgA, supplier, brandB],
    );
    await client.query("update public.supplier_prices set buy_price=21 where brand_id=$1", [brandB]);
    await rejected("update public.supplier_prices set brand_id=$1 where brand_id=$2", [brandA, brandB]);

    await client.query("update public.supplier_prices set description='catalog enrichment' where brand_id=$1", [brandA]);
    await rejected("delete from public.supplier_prices where brand_id=$1 and is_active is true", [brandA]);
    await client.query("delete from public.supplier_prices where brand_id=$1 and is_active is false", [brandA]);
    await client.query("select set_config('test.org', $1, true)", [orgB]);
    await client.query("select public.assert_legacy_supplier_price_write_allowed('A')");
    await client.query(
      "insert into public.supplier_prices(organization_id,supplier_id,brand_id,product_code,buy_price) values ($1,$2,$3,'OTHER',30)",
      [orgB, supplier, brandOtherOrg],
    );
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
