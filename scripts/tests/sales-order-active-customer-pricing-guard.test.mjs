import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const connectionString = process.env.SALES_ORDER_PRICING_GUARD_TEST_DATABASE_URL;
const stagingOrderFunctionsPath = process.env.STAGING_ORDER_FUNCTIONS_JSON;
const migration = await readFile(
  new URL("../../supabase/migrations/20261013140020_sales_order_active_customer_pricing_guard.sql", import.meta.url),
  "utf8",
);

test("sales-order writes use one active customer card while legacy C documents remain readable", {
  skip: !connectionString && "Set SALES_ORDER_PRICING_GUARD_TEST_DATABASE_URL to a disposable local PostgreSQL database",
}, async () => {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.equal(url.pathname, "/sales_order_pricing_guard_test");

  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query("begin");

  const org = "00000000-0000-0000-0000-000000000001";
  const otherOrg = "00000000-0000-0000-0000-000000000002";
  const aId = "10000000-0000-0000-0000-000000000001";
  const cId = "10000000-0000-0000-0000-000000000002";
  const otherId = "10000000-0000-0000-0000-000000000003";
  const bId = "10000000-0000-0000-0000-000000000012";

  async function rejected(sql, params, message) {
    await client.query("savepoint expected_rejection");
    try {
      await assert.rejects(client.query(sql, params), message);
    } finally {
      await client.query("rollback to savepoint expected_rejection");
      await client.query("release savepoint expected_rejection");
    }
  }

  try {
    await client.query(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.customers (
        id uuid primary key, organization_id uuid not null, display_name text not null,
        company_name text not null default '', price_list_type text,
        price_list_margin_percent numeric, custom_fields text not null default ''
      );
      create table public.sales_orders (
        id text primary key, organization_id uuid not null, customer_id uuid,
        customer_name text not null, customer_type text, status text not null default 'draft',
        lines jsonb not null default '[]'::jsonb, portal_seen_at timestamptz,
        updated_at timestamptz not null default now(),
        sales_order_no text not null default '', seller_company text not null default '',
        purchase_company text not null default '', quote_date text not null default '',
        currency text not null default 'EUR', shipping_cost numeric not null default 0,
        discount_amount numeric not null default 0, supplier_mode text not null default '',
        preferred_supplier text not null default '', seller_info text not null default '',
        buyer_info text not null default '', delivery_term text not null default '',
        payment_terms text not null default '', packing_details text not null default '',
        notes text not null default '', purchase_total numeric not null default 0,
        sales_total numeric not null default 0, profit_total numeric not null default 0,
        margin_percent numeric not null default 0, source_channel text not null default 'internal',
        portal_invite_id uuid, portal_submitted_at timestamptz, confirmed_at timestamptz,
        created_at timestamptz not null default now()
      );
      create table public.company_profiles (organization_id uuid not null, company_name text not null);
      create table public.purchase_orders (organization_id uuid not null, sales_order_id text);
      create table public.invoices (organization_id uuid not null, sales_order_id text, sales_order_ids text[]);
      create function public.current_profile_org_id() returns uuid language sql stable as
        $$select case when current_setting('role',true)='service_role' then null else '00000000-0000-0000-0000-000000000001'::uuid end$$;
      create function public.current_profile_role() returns text language sql stable as
        $$select case when current_setting('role',true)='service_role' then null else 'sales'::text end$$;
      create function public.is_superadmin() returns boolean language sql stable as $$select false$$;
    `);
    await client.query(
      "insert into public.customers(id,organization_id,display_name,company_name,price_list_type,price_list_margin_percent) values ($1,$4,'Active A','', 'A', null),($2,$4,'Retired C','', 'C', null),($3,$5,'Other Org','', 'A', null),($6,$4,'Active B','', 'B', null)",
      [aId, cId, otherId, org, otherOrg, bId],
    );
    await client.query(
      "insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('historical-c',$1,$2,'Retired C','C')",
      [org, cId],
    );
    await client.query(migration);
    const guardAcl = await client.query(`
      select n.nspname, p.prosecdef, p.proconfig,
        has_schema_privilege('authenticated', n.oid, 'USAGE') as authenticated_schema_usage,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='sales_order_guard_private'
        and p.proname='guard_sales_order_active_customer_pricing'
    `);
    assert.equal(guardAcl.rows[0].prosecdef, true);
    assert.deepEqual(guardAcl.rows[0].proconfig, ['search_path=""']);
    assert.equal(guardAcl.rows[0].authenticated_schema_usage, false);
    assert.equal(guardAcl.rows[0].authenticated_execute, false);
    assert.equal(guardAcl.rows[0].service_execute, false);

    // Optional live-shape integration: load read-only pg_get_functiondef snapshots
    // into this disposable database to verify the unchanged staging RPC chain.
    if (stagingOrderFunctionsPath) {
      const functions = JSON.parse(await readFile(stagingOrderFunctionsPath, "utf8"));
      await client.query("create schema auth; create schema order_commit_private");
      await client.query("create function auth.uid() returns uuid language sql stable as $$select '20000000-0000-0000-0000-000000000001'::uuid$$");
      await client.query(functions.normalizeLines);
      await client.query(functions.privateSave);
      await client.query(functions.wrapper);
      const activeRpc = await client.query(
        "select public.save_sales_order_atomic($1::jsonb) as result",
        [JSON.stringify({ id: "staging-rpc-a", customer_name: "Active A", customer_type: "A", lines: [] })],
      );
      assert.equal(activeRpc.rows[0].result.sales_order.customer_id, aId);
      const customerSwitched = await client.query(
        "select public.save_sales_order_atomic($1::jsonb) as result",
        [JSON.stringify({ id: "staging-rpc-a", customer_name: "Active B", customer_type: "B", lines: [] })],
      );
      assert.equal(customerSwitched.rows[0].result.sales_order.customer_id, bId);
      await rejected(
        "select public.save_sales_order_atomic($1::jsonb)",
        [JSON.stringify({ id: "staging-rpc-forged-a", customer_name: "Retired C", customer_type: "A", lines: [] })],
        /profile differs/,
      );
      await rejected(
        "select public.save_sales_order_atomic($1::jsonb)",
        [JSON.stringify({ id: "staging-rpc-new-confirmed", customer_name: "Active A", customer_type: "A", status: "confirmed", lines: [{ qty: 1, buy_price: 1, sell_price: 2 }] })],
        /atomic sales and purchase confirmation/,
      );
      const historicalPayload = (await client.query("select to_jsonb(so) as payload from public.sales_orders so where id='historical-c'"))
        .rows[0].payload;
      historicalPayload.notes = "staging RPC legacy note";
      const legacyRpc = await client.query(
        "select public.save_sales_order_atomic($1::jsonb) as result",
        [JSON.stringify(historicalPayload)],
      );
      assert.equal(legacyRpc.rows[0].result.sales_order.notes, "staging RPC legacy note");
      assert.equal(legacyRpc.rows[0].result.sales_order.customer_type, "C");
    }

    const active = await client.query(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('active-a',$1,'Active A','A') returning customer_id",
      [org],
    );
    assert.equal(active.rows[0].customer_id, aId);
    await client.query("grant usage on schema public to authenticated");
    await client.query("grant insert, select on public.sales_orders to authenticated");
    await client.query("grant select on public.customers to authenticated");
    await client.query("grant usage on schema public to service_role");
    await client.query("grant insert, select, update on public.sales_orders to service_role");
    await client.query("set role authenticated");
    const browserWrite = await client.query(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('browser-a',$1,'Active A','A') returning customer_id",
      [org],
    );
    assert.equal(browserWrite.rows[0].customer_id, aId);
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('staff-cross-org',$1,$2,'Other Org','A')",
      [otherOrg, otherId], /outside the active staff scope/,
    );
    await client.query("reset role");
    await client.query("set role service_role");
    const portalWrite = await client.query(
      "insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('portal-service',$1,$2,'Other Org','A') returning customer_id",
      [otherOrg, otherId],
    );
    assert.equal(portalWrite.rows[0].customer_id, otherId);
    await client.query("reset role");
    await client.query(`
      create function public.test_definer_sales_order_save(input_id text, input_org uuid)
      returns uuid language plpgsql security definer set search_path to '' as $$
      declare saved_customer_id uuid;
      begin
        insert into public.sales_orders(id,organization_id,customer_name,customer_type)
        values (input_id,input_org,'Active A','A') returning customer_id into saved_customer_id;
        return saved_customer_id;
      end;
      $$;
      grant execute on function public.test_definer_sales_order_save(text,uuid) to authenticated;
      revoke select on public.customers from authenticated;
    `);
    await client.query("set role authenticated");
    const rpcWrite = await client.query("select public.test_definer_sales_order_save('rpc-a',$1) as customer_id", [org]);
    assert.equal(rpcWrite.rows[0].customer_id, aId);
    const limitedStaffWrite = await client.query(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('limited-staff-a',$1,'Active A','A') returning customer_id",
      [org],
    );
    assert.equal(limitedStaffWrite.rows[0].customer_id, aId);
    await client.query("reset role");

    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('forged-a',$1,'Retired C','A')",
      [org], /profile differs/,
    );
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('new-c',$1,'Retired C','C')",
      [org], /Set A, B, or Other/,
    );
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('null-type',$1,'Active A',null)",
      [org], /Set A, B, or Other/,
    );
    await rejected(
      "update public.sales_orders set customer_type=null where id='active-a'",
      [], /Set A, B, or Other/,
    );
    await client.query("insert into public.customers(id,organization_id,display_name,company_name,price_list_type,price_list_margin_percent) values ('10000000-0000-0000-0000-000000000008',$1,'Null Profile','', null, null)", [org]);
    const defaultA = await client.query(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('null-profile-default-a',$1,'Null Profile','A') returning customer_id",
      [org],
    );
    assert.equal(defaultA.rows[0].customer_id, "10000000-0000-0000-0000-000000000008");
    await client.query("insert into public.customers(id,organization_id,display_name,price_list_type,custom_fields) values ('10000000-0000-0000-0000-000000000009',$1,'Embedded B',null,'[[NEXT_MASTER_META]]{\"price_list_type\":\"B\"}'),('10000000-0000-0000-0000-000000000010',$1,'Embedded Other',null,'[[NEXT_MASTER_META]]{\"price_list_type\":\"Other\",\"price_list_margin_percent\":8}'),('10000000-0000-0000-0000-000000000011',$1,'Embedded C',null,'[[NEXT_MASTER_META]]{\"price_list_type\":\"C\"}')", [org]);
    await client.query("insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('embedded-b',$1,'Embedded B','B'),('embedded-other',$1,'Embedded Other','Other')", [org]);
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('embedded-b-wrong',$1,'Embedded B','A')",
      [org], /profile differs/,
    );
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('embedded-c-forged',$1,'Embedded C','A')",
      [org], /profile differs/,
    );
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('cross-org',$1,$2,'Other Org','A')",
      [org, otherId], /outside this organization/,
    );
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('wrong-name',$1,$2,'Retired C','A')",
      [org, aId], /name does not match/,
    );
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('forged-upsert',$1,'Retired C','A') on conflict (id) do update set customer_type=excluded.customer_type",
      [org], /profile differs/,
    );

    const historical = await client.query("select customer_type from public.sales_orders where id='historical-c'");
    assert.equal(historical.rows[0].customer_type, "C");
    await client.query("update public.sales_orders set portal_seen_at=now(),updated_at=now() where id='historical-c'");
    await client.query("update public.sales_orders set notes='legacy note',status='confirmed',confirmed_at=now() where id='historical-c'");
    await client.query("insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('historical-c',$1,'Retired C','C') on conflict (id) do update set notes='legacy upsert'", [org]);
    const legacyAfterUpsert = await client.query("select notes,status,customer_type from public.sales_orders where id='historical-c'");
    assert.deepEqual(legacyAfterUpsert.rows[0], { notes: "legacy upsert", status: "confirmed", customer_type: "C" });
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type,lines) values ('historical-c',$1,'Retired C','C','[{\"sell_price\":10}]'::jsonb) on conflict (id) do update set lines=excluded.lines",
      [org], /Set A, B, or Other/,
    );
    await rejected(
      "update public.sales_orders set lines='[{\"sell_price\":10}]'::jsonb where id='historical-c'",
      [], /Set A, B, or Other/,
    );
    await client.query("update public.customers set price_list_type='A' where id=$1", [cId]);
    await client.query("update public.sales_orders set customer_type='A' where id='historical-c'");

    await client.query("insert into public.customers(id,organization_id,display_name,company_name,price_list_type,price_list_margin_percent) values ('10000000-0000-0000-0000-000000000004',$1,'Duplicate','', 'A', null),('10000000-0000-0000-0000-000000000005',$1,'Duplicate','', 'A', null)", [org]);
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('ambiguous',$1,'Duplicate','A')",
      [org], /exactly one account/,
    );
    await client.query("insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('explicit',$1,'10000000-0000-0000-0000-000000000004','Duplicate','A')", [org]);
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('new-duplicate',$1,'Duplicate','A')",
      [org],
      /exactly one account/,
    );
    await client.query("insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('explicit',$1,'10000000-0000-0000-0000-000000000004','Duplicate','A') on conflict(id) do update set notes='bound duplicate'", [org]);
    if (stagingOrderFunctionsPath) {
      await rejected(
        "select public.save_sales_order_atomic($1::jsonb)",
        [JSON.stringify({ id: "staging-rpc-new-duplicate", customer_name: "Duplicate", customer_type: "A", lines: [] })],
        /exactly one account/,
      );
      const boundDuplicate = await client.query(
        "select public.save_sales_order_atomic($1::jsonb) as result",
        [JSON.stringify({ id: "explicit", customer_name: "Duplicate", customer_type: "A", lines: [] })],
      );
      assert.equal(boundDuplicate.rows[0].result.sales_order.customer_id, "10000000-0000-0000-0000-000000000004");
    }
    await client.query("insert into public.customers(id,organization_id,display_name,company_name,price_list_type,price_list_margin_percent,custom_fields) values ('10000000-0000-0000-0000-000000000006',$1,'Special','', 'Other', null, 'Notes [[NEXT_MASTER_META]]{\"price_list_margin_percent\":12.5}')", [org]);
    const legacyOther = await client.query(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('legacy-other',$1,'Special','Other') returning customer_id",
      [org],
    );
    assert.equal(legacyOther.rows[0].customer_id, "10000000-0000-0000-0000-000000000006");
    await client.query("update public.customers set custom_fields='' where id='10000000-0000-0000-0000-000000000006'");
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('other-no-margin',$1,'Special','Other')",
      [org], /requires a valid account margin/,
    );
    await client.query("update public.customers set custom_fields='[[NEXT_MASTER_META]]not-json' where id='10000000-0000-0000-0000-000000000006'");
    await rejected(
      "insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('other-bad-meta',$1,'Special','Other')",
      [org], /requires a valid account margin/,
    );
    await client.query("insert into public.customers(id,organization_id,display_name,company_name,price_list_type,price_list_margin_percent) values ('10000000-0000-0000-0000-000000000007',$1,'','', 'A', null)", [org]);
    await client.query(
      "insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('portal-alias',$1,'10000000-0000-0000-0000-000000000007','Invite Alias','A')",
      [org],
    );

    await client.query("insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type) values ('renamed-bound',$1,$2,'Active A','A')", [org, aId]);
    await client.query("update public.customers set display_name='Renamed A' where id=$1", [aId]);
    await client.query("update public.sales_orders set notes='customer renamed' where id='renamed-bound'");
    await client.query("insert into public.sales_orders(id,organization_id,customer_name,customer_type) values ('renamed-bound',$1,'Active A','A') on conflict(id) do update set notes='upserted'", [org]);
    await client.query("update public.sales_orders set customer_name='Renamed A' where id='renamed-bound'");

    await client.query("update public.customers set price_list_type='B' where id=$1", [aId]);
    await rejected(
      "update public.sales_orders set notes='stale profile' where id='renamed-bound'",
      [],
      /profile differs/,
    );
    await client.query("update public.sales_orders set customer_type='B' where id='renamed-bound'");
  } finally {
    await client.query("rollback");
    await client.end();
  }
});
