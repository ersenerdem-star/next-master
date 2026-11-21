import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("sales-order OE lookup honors active sales permissions, tenant RLS and exact OE matches", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create schema staff_office_guard;
      create function staff_office_guard.is_allowed() returns boolean language sql stable as $$select coalesce(current_setting('test.office',true),'') <> 'denied'$$;
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('test.user_id', true), '')::uuid$$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.uid() to authenticated;
      create table public.profiles(id uuid primary key, organization_id uuid, role text, is_active boolean, allowed boolean);
      create table public.brands(id uuid primary key, organization_id uuid, name text);
      create table public.catalog_products(id uuid primary key, organization_id uuid, brand_id uuid,
        product_code text, description text, vehicle text, oem_no text, normalized_oem text);
      create table public.catalog_product_identifiers(organization_id uuid, catalog_product_id uuid,
        identifier_type text, value text, normalized_value text);
      create function public.normalize_part_code(v text) returns text language sql immutable as
        $$select regexp_replace(upper(coalesce(v,'')), '[^A-Z0-9]', '', 'g')$$;
      create function public.current_profile_org_id() returns uuid language sql stable security definer as
        $$select organization_id from public.profiles where id = auth.uid() and is_active$$;
      create function public.current_profile_role() returns text language sql stable security definer as
        $$select case when role='superadmin' then 'admin' else role end from public.profiles where id=auth.uid() and is_active$$;
      create function public.profile_has_permission(key text) returns boolean language sql stable security definer as
        $$select allowed from public.profiles where id=auth.uid() and is_active$$;
      grant usage on schema public to authenticated;
      grant select on public.profiles, public.brands, public.catalog_products, public.catalog_product_identifiers to authenticated;
      alter table public.profiles enable row level security;
      alter table public.brands enable row level security;
      alter table public.catalog_products enable row level security;
      alter table public.catalog_product_identifiers enable row level security;
      create policy own_profile on public.profiles for select to authenticated using (id=auth.uid());
      create policy own_brands on public.brands for select to authenticated using (organization_id=public.current_profile_org_id());
      create policy own_products on public.catalog_products for select to authenticated using (organization_id=public.current_profile_org_id());
      create policy own_identifiers on public.catalog_product_identifiers for select to authenticated using (organization_id=public.current_profile_org_id());
      insert into public.profiles values
        ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000100','sales',true,true),
        ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000100','sales',false,true),
        ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000100','sales',true,false),
        ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000100','viewer',true,true),
        ('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000200','sales',true,true);
      insert into public.brands values
        ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000100','TITANX'),
        ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000200','TITANX');
      insert into public.catalog_products values
        ('00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000101','CD119002','one',null,null,null),
        ('00000000-0000-0000-0000-000000000112','00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000101','CX119002','two',null,null,null),
        ('00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000101','SCALAR','three',null,'00-ABC, 940 500 04 54','00ABC9405000454'),
        ('00000000-0000-0000-0000-000000000114','00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000101','PREFIX','four',null,'A9405000454','A9405000454'),
        ('00000000-0000-0000-0000-000000000211','00000000-0000-0000-0000-000000000200','00000000-0000-0000-0000-000000000201','OTHER','other tenant',null,null,null);
      insert into public.catalog_product_identifiers values
        ('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000111','oem','9405000454','9405000454'),
        ('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000111','oem','940 500 04 54','9405000454'),
        ('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000112','oem','9405000454','9405000454'),
        ('00000000-0000-0000-0000-000000000200','00000000-0000-0000-0000-000000000211','oem','9405000454','9405000454');
    `);
    await db.exec(await readFile(new URL("../../supabase/migrations/20261120144122_sales_order_exact_oe_candidates.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../../supabase/migrations/20261121120031_sales_order_oe_lookup_performance.sql", import.meta.url), "utf8"));
    await db.exec("set role authenticated; select set_config('test.user_id','00000000-0000-0000-0000-000000000001',false)");
    let result = await db.query("select * from public.sales_order_exact_oe_candidates('9405000454','',1,2)");
    assert.deepEqual(result.rows.map((r) => r.product_code), ["CD119002", "CX119002"]);
    assert.ok(result.rows.every((r) => r.has_more));
    result = await db.query("select * from public.sales_order_exact_oe_candidates('9405000454','TITANX',1,20)");
    assert.deepEqual(result.rows.map((r) => r.product_code), ["CD119002", "CX119002", "SCALAR"]);
    result = await db.query("select * from public.sales_order_exact_oe_candidates('9405000454','',2,2)");
    assert.deepEqual(result.rows.map((r) => r.product_code), ["SCALAR"]);
    assert.equal(result.rows[0].has_more, false);
    result = await db.query("select * from public.sales_order_exact_oe_candidates('9405000454','other-brand',1,20)");
    assert.equal(result.rows.length, 0);
    result = await db.query("select * from public.sales_order_exact_oe_candidates('A9405000454','',1,20)");
    assert.deepEqual(result.rows.map((r) => r.product_code), ["PREFIX"]);
    await db.exec("select set_config('test.office','denied',false)");
    await assert.rejects(db.query("select * from sales_oe_lookup_private.scalar_oe_candidate_ids('9405000454')"), /Active sales-order access required/);
    await db.exec("select set_config('test.office','',false)");
    for (const user of ["00000000-0000-0000-0000-000000000002", "00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000004", ""]) {
      await db.query("select set_config('test.user_id', $1, false)", [user]);
      await assert.rejects(db.query("select * from public.sales_order_exact_oe_candidates('9405000454')"), /Active sales-order access required/);
      await assert.rejects(db.query("select * from sales_oe_lookup_private.scalar_oe_candidate_ids('9405000454')"), /Active sales-order access required/);
    }
    await db.query("select set_config('test.user_id', $1, false)", ["00000000-0000-0000-0000-000000000005"]);
    result = await db.query("select * from public.sales_order_exact_oe_candidates('9405000454')");
    assert.deepEqual(result.rows.map((r) => r.product_code), ["OTHER"]);
    result = await db.query("select * from sales_oe_lookup_private.scalar_oe_candidate_ids('9405000454')");
    assert.deepEqual(result.rows, []);
  } finally {
    await db.close();
  }
});
