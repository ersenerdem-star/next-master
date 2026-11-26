import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';

// Disposable local PostgreSQL only; no production data or credentials.
test('saved sales and purchase orders reject stale and legacy writers under concurrent sessions', { timeout: 120000 }, async () => {
  const name = `nm-concurrency-${process.pid}`;
  let pool;
  try {
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=localtest', '-p', '127.0.0.1::5432', 'postgres:17'], { stdio: 'ignore' });
    const port = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    pool = new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'localtest', database: 'postgres', max: 4 });
    for (let n = 0; ; n++) {
      try { await pool.query('select 1'); break; } catch (e) { if (n >= 60) throw e; await new Promise(r => setTimeout(r, 500)); }
    }
    const setup = `
      create role anon; create role authenticated; create role service_role;
      create function public.current_profile_org_id() returns uuid language sql stable as $$select '00000000-0000-0000-0000-000000000001'::uuid$$;
      create function public.current_profile_role() returns text language sql stable as $$select 'admin'::text$$;
      create function public.is_superadmin() returns boolean language sql stable as $$select false$$;
      create table public.sales_orders (organization_id uuid not null, id text not null, updated_at timestamptz not null default clock_timestamp(), lines jsonb, primary key(organization_id,id));
      create table public.purchase_orders (organization_id uuid not null, id text not null, updated_at timestamptz not null default clock_timestamp(), lines jsonb, primary key(organization_id,id));
      create function public.save_sales_order_atomic(payload jsonb, previous_id text default null) returns jsonb language plpgsql security definer as $$
      declare v public.sales_orders; begin
      insert into public.sales_orders as s (organization_id,id,lines) values(public.current_profile_org_id(), payload->>'id', payload->'lines')
      on conflict(organization_id,id) do update set lines=excluded.lines,updated_at=clock_timestamp() returning * into v;
      return jsonb_build_object('sales_order',to_jsonb(v)); end $$;
      create function public.save_purchase_order_atomic(payload jsonb, previous_id text default null) returns jsonb language plpgsql security definer as $$
      declare v public.purchase_orders; begin
      insert into public.purchase_orders as p (organization_id,id,lines) values(public.current_profile_org_id(), payload->>'id', payload->'lines')
      on conflict(organization_id,id) do update set lines=excluded.lines,updated_at=clock_timestamp() returning * into v;
      return jsonb_build_object('purchase_order',to_jsonb(v)); end $$;`;
    await pool.query(setup);
    const migration = readFileSync(new URL('../../supabase/migrations/20261126135620_optimistic_order_versions.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    for (const kind of ['sales', 'purchase']) {
      const rpc = `public.save_${kind}_order_atomic`;
      const id = `${kind}-test`;
      const call = (client, payload) => client.query(`select ${rpc}($1::jsonb) as result`, [JSON.stringify(payload)]);
      const created = await call(pool, { id, lines: ['original'] });
      const version = created.rows[0].result[`${kind}_order`].updated_at;
      await assert.rejects(call(pool, { id, lines: ['old bundle'] }), new RegExp(`${kind.toUpperCase()}_ORDER_VERSION_REQUIRED`));
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('begin');
        await b.query('begin');
        const first = await call(a, { id, lines: ['first'], expected_updated_at: version });
        const pending = call(b, { id, lines: ['second'], expected_updated_at: version });
        await new Promise(r => setTimeout(r, 150));
        await a.query('commit');
        await assert.rejects(pending, new RegExp(`${kind.toUpperCase()}_ORDER_STALE_VERSION`));
        await b.query('rollback');
        const saved = await pool.query(`select lines from public.${kind}_orders where id=$1`, [id]);
        assert.deepEqual(saved.rows[0].lines, ['first']);
        const nextVersion = first.rows[0].result[`${kind}_order`].updated_at;
        await call(pool, { id, lines: ['after reload'], expected_updated_at: nextVersion });
        await assert.rejects(call(pool, { id: `${id}-missing`, lines: [], expected_updated_at: nextVersion }), new RegExp(`${kind.toUpperCase()}_ORDER_STALE_VERSION`));
      } finally { a.release(); b.release(); }
    }
  } finally {
    if (pool) await pool.end();
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch {}
  }
});
