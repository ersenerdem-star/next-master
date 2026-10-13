import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

const connectionString = process.env.SALES_ORDER_PRICING_GUARD_TEST_DATABASE_URL;
const customerGuard = await readFile(
  new URL("../../supabase/migrations/20261013140020_sales_order_active_customer_pricing_guard.sql", import.meta.url),
  "utf8",
);
const marginGuard = await readFile(
  new URL("../../supabase/migrations/20261013140022_sales_order_confirmed_current_margin_guard.sql", import.meta.url),
  "utf8",
);

test("confirmed orders use current locked account/list margins", {
  skip: !connectionString && "Set SALES_ORDER_PRICING_GUARD_TEST_DATABASE_URL to a disposable local PostgreSQL database",
}, async () => {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(url.hostname));
  assert.equal(url.pathname, "/sales_order_pricing_guard_test");

  const client = new pg.Client({ connectionString });
  await client.connect();
  const org = "00000000-0000-0000-0000-000000000001";
  const a = "10000000-0000-0000-0000-000000000001";
  const b = "10000000-0000-0000-0000-000000000002";
  const other = "10000000-0000-0000-0000-000000000003";
  const legacyC = "10000000-0000-0000-0000-000000000004";
  const listA = "20000000-0000-0000-0000-000000000001";
  const listB = "20000000-0000-0000-0000-000000000002";
  const listANewer = "20000000-0000-0000-0000-000000000003";
  const listBNewer = "20000000-0000-0000-0000-000000000004";
  const listBInactive = "20000000-0000-0000-0000-000000000005";

  const line = (buy, sell, manual = false) => [{
    requestedCode: "X1", brand: "Example", qty: 1, buy_price: buy,
    sell_price: sell, manual_sell_price: manual,
  }];
  const insert = (id, name, type, lines, status = "confirmed") => client.query(
    `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
     values ($1,$2,$3,$4,$5,$6::jsonb) returning customer_id`,
    [id, org, name, type, status, JSON.stringify(lines)],
  );

  try {
    await client.query(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.organizations (id uuid primary key);
      create table public.customers (
        id uuid primary key, organization_id uuid not null,
        display_name text not null, company_name text not null default '',
        price_list_type text, price_list_margin_percent numeric,
        custom_fields text not null default ''
      );
      create table public.customer_price_lists (
        id uuid primary key, organization_id uuid not null references public.organizations(id),
        list_type text not null, margin_percent numeric,
        is_active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table public.sales_orders (
        id text primary key, organization_id uuid not null,
        customer_id uuid, customer_name text not null,
        customer_type text, status text not null default 'draft',
        source_channel text not null default 'internal',
        lines jsonb not null default '[]'::jsonb,
        notes text not null default '', portal_seen_at timestamptz,
        confirmed_at timestamptz, updated_at timestamptz not null default now()
      );
      create function public.current_profile_org_id() returns uuid
        language sql stable as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;
      create function public.current_profile_role() returns text
        language sql stable as $$select 'sales'::text$$;
      create function public.is_superadmin() returns boolean
        language sql stable as $$select false$$;
    `);
    await client.query("insert into public.organizations(id) values ($1)", [org]);
    await client.query(
      `insert into public.customers(id,organization_id,display_name,price_list_type,price_list_margin_percent,custom_fields)
       values ($1,$5,'Account A','A',null,''),
              ($2,$5,'Account B','B',null,''),
              ($3,$5,'Special','Other',null,'[[NEXT_MASTER_META]]{"price_list_margin_percent":8}'),
              ($4,$5,'Retired C','C',null,'')`,
      [a, b, other, legacyC, org],
    );
    await client.query(
      `insert into public.customer_price_lists(id,organization_id,list_type,margin_percent)
       values ($1,$3,'A',10),($2,$3,'B',15)`, [listA, listB, org],
    );
    await client.query(
      "insert into public.sales_orders(id,organization_id,customer_id,customer_name,customer_type,status,lines) values ('historical-c',$1,$2,'Retired C','C','confirmed','[]'::jsonb)",
      [org, legacyC],
    );
    await client.query(customerGuard);
    await client.query(marginGuard);

    const guard = await client.query(`
      select p.prosecdef, p.proconfig,
        has_schema_privilege('authenticated', n.oid, 'USAGE') as can_use_schema,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as can_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='sales_order_guard_private'
        and p.proname='guard_confirmed_sales_order_margin'
    `);
    assert.deepEqual(guard.rows[0], {
      prosecdef: true, proconfig: ['search_path=""'],
      can_use_schema: false, can_execute: false,
    });

    assert.equal((await insert("a-10", "Account A", "A", line(10, 11))).rows[0].customer_id, a);
    await insert("a-half-cent", "Account A", "A", line(0.05, 0.06));
    await assert.rejects(insert("a-unrounded", "Account A", "A", line(0.05, 0.05)), /margin changed/);
    assert.equal((await insert("b-15", "Account B", "B", line(10, 11.5))).rows[0].customer_id, b);
    assert.equal((await insert("other-8", "Special", "Other", line(10, 10.8))).rows[0].customer_id, other);
    await assert.rejects(insert("a-wrong", "Account A", "A", line(10, 11.01)), /margin changed/);
    await assert.rejects(
      client.query(
        `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,source_channel,lines)
         values ('forged-portal',$1,'Account A','A','confirmed','portal',$2::jsonb)`,
        [org, JSON.stringify(line(10, 20))],
      ), /margin changed/,
    );
    await assert.rejects(insert("b-wrong", "Account B", "B", line(10, 11)), /margin changed/);
    await assert.rejects(insert("a-fake-manual", "Account A", "A", [{...line(10, 20)[0], manual_sell_price: "true"}]), /margin changed/);
    await insert("a-manual", "Account A", "A", line(10, 20, true));

    await insert("a-draft", "Account A", "A", line(10, 11), "draft");
    await client.query(
      `insert into public.customer_price_lists(id,organization_id,list_type,margin_percent,created_at,updated_at)
       select $1,organization_id,'A',13,created_at + interval '1 second',updated_at
       from public.customer_price_lists where id=$2`,
      [listANewer, listA],
    );
    await insert("a-created-at-tie", "Account A", "A", line(10, 11.3));
    await client.query("update public.customer_price_lists set margin_percent=12,updated_at=now() + interval '2 seconds' where id=$1", [listA]);
    await assert.rejects(
      client.query("update public.sales_orders set status='confirmed' where id='a-draft'"),
      /margin changed/,
    );
    await client.query("update public.sales_orders set lines=$1::jsonb,status='confirmed' where id='a-draft'", [JSON.stringify(line(10, 11.2))]);
    await assert.rejects(insert("a-stale", "Account A", "A", line(10, 11)), /margin changed/);
    await client.query("update public.sales_orders set notes='original price retained',portal_seen_at=now() where id='a-10'");
    await client.query("update public.sales_orders set notes='historical C note' where id='historical-c'");

    await client.query("update public.customers set price_list_margin_percent=7.5 where id=$1", [a]);
    await assert.rejects(insert("a-list-ignored", "Account A", "A", line(10, 11.2)), /margin changed/);
    await insert("a-override", "Account A", "A", line(10, 10.75));
    await client.query("update public.sales_orders set notes='account override changed' where id='a-10'");

    // The INSERT arm of ON CONFLICT skips an existing row; the actual UPDATE
    // arm must still validate a changed confirmation against the current list.
    await assert.rejects(
      client.query(
        `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
         values ('a-draft',$1,'Account A','A','confirmed',$2::jsonb)
         on conflict (id) do update set lines=excluded.lines,status=excluded.status`,
        [org, JSON.stringify(line(10, 11))],
      ), /margin changed/,
    );
    await client.query(
      `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
       values ('a-10',$1,'Account A','A','confirmed',$2::jsonb)
       on conflict (id) do update set notes='upserted historical note'`,
      [org, JSON.stringify(line(10, 11))],
    );

    await client.query("update public.customer_price_lists set margin_percent=18,updated_at=now() where id=$1", [listB]);
    await assert.rejects(insert("b-old-margin", "Account B", "B", line(10, 11.5)), /margin changed/);
    await insert("b-new-margin", "Account B", "B", line(10, 11.8));
    await client.query("update public.customer_price_lists set is_active=false where id=$1", [listB]);
    await insert("b-default", "Account B", "B", line(10, 11.5));

    // The confirming transaction must wait for an in-flight list update,
    // then compare against the committed value rather than the old snapshot.
    await client.query("update public.customer_price_lists set is_active=true,margin_percent=15 where id=$1", [listB]);
    const updater = new pg.Client({ connectionString });
    const confirmer = new pg.Client({ connectionString });
    await Promise.all([updater.connect(), confirmer.connect()]);
    try {
      await updater.query("begin");
      await updater.query("update public.customer_price_lists set margin_percent=19 where id=$1", [listB]);
      await confirmer.query("begin");
      await confirmer.query("set local statement_timeout='5s'");
      const racedConfirmation = confirmer.query(
        `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
         values ('b-raced',$1,'Account B','B','confirmed',$2::jsonb)`,
        [org, JSON.stringify(line(10, 11.5))],
      );
      let blocked = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activity = await client.query(
          "select wait_event_type from pg_stat_activity where pid=$1", [confirmer.processID],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(blocked, true, "confirmation should wait for the current price-list row");
      await updater.query("commit");
      await assert.rejects(racedConfirmation, /margin changed/);
      await confirmer.query("rollback");

      await updater.query("begin");
      await updater.query("update public.customers set price_list_margin_percent=6 where id=$1", [b]);
      await confirmer.query("begin");
      await confirmer.query("set local statement_timeout='5s'");
      const racedAccount = confirmer.query(
        `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
         values ('b-raced-account',$1,'Account B','B','confirmed',$2::jsonb)`,
        [org, JSON.stringify(line(10, 11.9))],
      );
      blocked = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activity = await client.query(
          "select wait_event_type from pg_stat_activity where pid=$1", [confirmer.processID],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(blocked, true, "confirmation should wait for the current customer row");
      await updater.query("commit");
      await assert.rejects(racedAccount, /margin changed/);
      await confirmer.query("rollback");

      await client.query("update public.customers set price_list_margin_percent=null where id=$1", [b]);
      await updater.query("begin");
      await updater.query(
        `insert into public.customer_price_lists(id,organization_id,list_type,margin_percent,created_at,updated_at)
         values ($1,$2,'B',22,now() + interval '3 seconds',now() + interval '3 seconds')`,
        [listBNewer, org],
      );
      await confirmer.query("begin");
      await confirmer.query("set local statement_timeout='5s'");
      const racedListInsert = confirmer.query(
        `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
         values ('b-raced-list-insert',$1,'Account B','B','confirmed',$2::jsonb)`,
        [org, JSON.stringify(line(10, 11.9))],
      );
      blocked = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activity = await client.query(
          "select wait_event_type from pg_stat_activity where pid=$1", [confirmer.processID],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(blocked, true, "confirmation should wait for a new active price-list row");
      await updater.query("commit");
      await assert.rejects(racedListInsert, /margin changed/);
      await confirmer.query("rollback");

      await client.query(
        `insert into public.customer_price_lists(id,organization_id,list_type,margin_percent,is_active,created_at,updated_at)
         values ($1,$2,'B',25,false,now() + interval '4 seconds',now() + interval '4 seconds')`,
        [listBInactive, org],
      );
      await updater.query("begin");
      await updater.query("update public.customer_price_lists set is_active=true where id=$1", [listBInactive]);
      await confirmer.query("begin");
      await confirmer.query("set local statement_timeout='5s'");
      const racedActivation = confirmer.query(
        `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
         values ('b-raced-activation',$1,'Account B','B','confirmed',$2::jsonb)`,
        [org, JSON.stringify(line(10, 12.2))],
      );
      blocked = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activity = await client.query(
          "select wait_event_type from pg_stat_activity where pid=$1", [confirmer.processID],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(blocked, true, "confirmation should wait for an inactive list being activated");
      await updater.query("commit");
      await assert.rejects(racedActivation, /margin changed/);
      await confirmer.query("rollback");

      await updater.query("begin");
      await updater.query("update public.customers set price_list_type='B' where id=$1", [a]);
      await confirmer.query("begin");
      await confirmer.query("set local statement_timeout='5s'");
      const racedProfile = confirmer.query(
        `insert into public.sales_orders(id,organization_id,customer_name,customer_type,status,lines)
         values ('a-raced-profile',$1,'Account A','A','confirmed',$2::jsonb)`,
        [org, JSON.stringify(line(10, 10.75))],
      );
      blocked = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const activity = await client.query(
          "select wait_event_type from pg_stat_activity where pid=$1", [confirmer.processID],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(blocked, true, "confirmation should wait for the current customer profile");
      await updater.query("commit");
      await assert.rejects(racedProfile, /pricing profile changed/);
      await confirmer.query("rollback");
    } finally {
      await Promise.allSettled([updater.query("rollback"), confirmer.query("rollback")]);
      await Promise.all([updater.end(), confirmer.end()]);
    }

    await client.query("update public.customers set price_list_type='B' where id=$1", [a]);
    await assert.rejects(insert("a-stale-type", "Account A", "A", line(10, 10.75)), /profile differs/);
  } finally {
    await client.end();
  }
});
