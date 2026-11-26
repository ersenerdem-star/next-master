import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const initial = readFileSync(new URL('../../supabase/migrations/20260707_94_payment_atomic_status_boundary.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20261126133711_payment_integrity_guard.sql', import.meta.url), 'utf8');

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.invoices(id text primary key, organization_id uuid, customer_name text, currency text);
    create table public.bills(id text primary key, organization_id uuid, supplier_name text, purchase_company text, currency text);
    create table public.payments_received(id text primary key, organization_id uuid, invoice_id text, invoice_no text, customer_name text, currency text, received_date text, amount numeric, method text, reference_no text, notes text, status text, created_at timestamptz, updated_at timestamptz);
    create table public.payments_made(id text primary key, organization_id uuid, bill_id text, bill_no text, supplier_name text, purchase_company text, currency text, payment_date text, amount numeric, method text, reference_no text, notes text, status text, created_at timestamptz, updated_at timestamptz);
    create table public.recalc_log(kind text, document_id text);
    create function public.current_profile_org_id() returns uuid language sql as $$select coalesce(nullif(current_setting('test.org',true),''),'00000000-0000-0000-0000-000000000001')::uuid$$;
    create function public.current_profile_role() returns text language sql as $$select coalesce(nullif(current_setting('test.role',true),''),'admin')::text$$;
    create function public.is_superadmin() returns boolean language sql as $$select false$$;
    create function public.recalculate_invoice_paid_status_for_org(uuid,text) returns jsonb language plpgsql as $$begin insert into public.recalc_log values('invoice',$2); return jsonb_build_object('id',$2); end;$$;
    create function public.recalculate_bill_paid_status_for_org(uuid,text) returns jsonb language plpgsql as $$begin insert into public.recalc_log values('bill',$2); return jsonb_build_object('id',$2); end;$$;
    insert into public.invoices values ('A','00000000-0000-0000-0000-000000000001','C','EUR'), ('B','00000000-0000-0000-0000-000000000001','C','EUR');
    insert into public.bills values ('A','00000000-0000-0000-0000-000000000001','S','P','EUR'), ('B','00000000-0000-0000-0000-000000000001','S','P','EUR');
    insert into public.payments_received values('P','00000000-0000-0000-0000-000000000001','A','A','C','EUR','2026-01-01',100,'Bank','', '', 'confirmed',now(),now());
    insert into public.payments_made values('P','00000000-0000-0000-0000-000000000001','A','A','S','P','EUR','2026-01-01',100,'Bank','', '', 'confirmed',now(),now());
    insert into public.payments_received(id,organization_id,invoice_id,amount) values('FOREIGN','00000000-0000-0000-0000-000000000002','A',77);
  `);
  const received = initial.indexOf('create or replace function public.save_payment_received_atomic(');
  const made = initial.indexOf('create or replace function public.save_payment_made_atomic(', received);
  const end = initial.indexOf('create or replace function public.delete_payment_received_guarded(', made);
  assert.ok(received >= 0 && made > received && end > made);
  await db.exec(initial.slice(received, made));
  await db.exec(initial.slice(made, end));
  await db.exec(migration);
  return db;
}

const payload = (target) => JSON.stringify({id:'P', [target]: 'B', amount:100, currency:'EUR', status:'confirmed'});

test('moving a receipt and a payment recalculates both the old and new document', async () => {
  const db = await fixture();
  try {
    const received = await db.query('select public.save_payment_received_atomic($1::jsonb,$2) result', [payload('invoice_id'),'P']);
    const made = await db.query('select public.save_payment_made_atomic($1::jsonb,$2) result', [payload('bill_id'),'P']);
    const log = await db.query('select kind,document_id from public.recalc_log order by kind,document_id');
    assert.deepEqual(log.rows, [{kind:'bill',document_id:'A'},{kind:'bill',document_id:'B'}, {kind:'invoice',document_id:'A'},{kind:'invoice',document_id:'B'}]);
    assert.equal(received.rows[0].result.previous_invoice.id, 'A');
    assert.equal(made.rows[0].result.previous_bill.id, 'A');
  } finally { await db.close(); }
});

test('a new payment cannot overwrite an existing id or its normalized variant', async () => {
  const db = await fixture();
  try {
    for (const [fn, field] of [['save_payment_received_atomic','invoice_id'], ['save_payment_made_atomic','bill_id']]) {
      for (const id of ['P',' p ']) {
        await assert.rejects(() => db.query(`select public.${fn}($1::jsonb,$2)`, [JSON.stringify({id, [field]:'B',amount:200,currency:'EUR'}),null]), /PAYMENT_NUMBER_ALREADY_USED/);
      }
    }
    const receipt = await db.query('select amount,invoice_id from public.payments_received where id=$1', ['P']);
    const payment = await db.query('select amount,bill_id from public.payments_made where id=$1', ['P']);
    assert.equal(Number(receipt.rows[0].amount), 100); assert.equal(receipt.rows[0].invoice_id, 'A');
    assert.equal(Number(payment.rows[0].amount), 100); assert.equal(payment.rows[0].bill_id, 'A');
  } finally { await db.close(); }
});

test('renumbering a payment does not overwrite another payment', async () => {
  const db = await fixture();
  try {
    await db.query(`insert into public.payments_received(id,organization_id,invoice_id,amount) values('OTHER','00000000-0000-0000-0000-000000000001','A',55)`);
    await assert.rejects(() => db.query('select public.save_payment_received_atomic($1::jsonb,$2)', [JSON.stringify({id:'other',invoice_id:'B',amount:100,currency:'EUR'}),'P']), /PAYMENT_NUMBER_ALREADY_USED/);
    const rows = await db.query('select id from public.payments_received order by id');
    assert.deepEqual(rows.rows.map(r => r.id), ['FOREIGN','OTHER','P']);
  } finally { await db.close(); }
});

test('another organization or a non-admin cannot overwrite a payment', async () => {
  const db = await fixture();
  try {
    await assert.rejects(() => db.query('select public.save_payment_received_atomic($1::jsonb,$2)', [JSON.stringify({id:'FOREIGN',invoice_id:'A',amount:200,currency:'EUR'}),null]), /PAYMENT_NUMBER_ALREADY_USED/);
    await assert.rejects(() => db.query('select public.save_payment_received_atomic($1::jsonb,$2)', [JSON.stringify({id:'NEW',invoice_id:'A',amount:200,currency:'EUR'}),'FOREIGN']), /Previous received payment was not found/);
    await db.exec("select set_config('test.role','sales',false)");
    await assert.rejects(() => db.query('select public.save_payment_received_atomic($1::jsonb,$2)', [payload('invoice_id'),'P']), /Only active admin/);
    const foreign = await db.query('select amount from public.payments_received where id=$1', ['FOREIGN']);
    assert.equal(Number(foreign.rows[0].amount), 77);
  } finally { await db.close(); }
});

test('payment updates require an unchanged version and reject older clients', async () => {
  const db = await fixture();
  try {
    await db.exec("grant insert, update, delete on public.payments_received, public.payments_made to authenticated");
    await db.exec(readFileSync(new URL('../../supabase/migrations/20261126140500_payment_version_guard.sql', import.meta.url), 'utf8'));
    const privileges = await db.query("select has_table_privilege('authenticated','public.payments_received','UPDATE') r, has_table_privilege('authenticated','public.payments_made','DELETE') m");
    assert.equal(privileges.rows[0].r, false); assert.equal(privileges.rows[0].m, false);
    for (const [fn, table, field] of [['save_payment_received_atomic', 'payments_received', 'invoice_id'], ['save_payment_made_atomic', 'payments_made', 'bill_id']]) {
      const original = (await db.query(`select updated_at::text as version from public.${table} where id='P'`)).rows[0].version;
      const data = { id:'P', [field]:'B', amount:123, currency:'EUR', status:'confirmed' };
      await assert.rejects(() => db.query(`select public.${fn}($1::jsonb,$2)`, [JSON.stringify(data),'P']), /PAYMENT_VERSION_REQUIRED/);
      await assert.rejects(() => db.query(`select public.${fn}($1::jsonb,$2)`, [JSON.stringify({...data,expected_updated_at:'2020-01-01T00:00:00Z'}),'P']), /PAYMENT_VERSION_CONFLICT/);
      const unchanged = (await db.query(`select amount,${field} from public.${table} where id='P'`)).rows[0];
      assert.equal(Number(unchanged.amount),100); assert.equal(unchanged[field],'A');
      await db.query(`select public.${fn}($1::jsonb,$2)`, [JSON.stringify({...data,expected_updated_at:original}),'P']);
      const saved = (await db.query(`select amount,${field} from public.${table} where id='P'`)).rows[0];
      assert.equal(Number(saved.amount),123); assert.equal(saved[field],'B');
      await assert.rejects(() => db.query(`select public.${fn}($1::jsonb,$2)`, [JSON.stringify({...data,amount:999,expected_updated_at:original}),'P']), /PAYMENT_VERSION_CONFLICT/);
    }
  } finally { await db.close(); }
});

test('deleting payments requires the current version and recalculates the document', async () => {
  const db = await fixture();
  try {
    const start = initial.indexOf('create or replace function public.delete_payment_received_guarded(');
    const end = initial.indexOf('grant execute on function public.save_payment_received_atomic', start);
    await db.exec(initial.slice(start, end));
    await db.exec(readFileSync(new URL('../../supabase/migrations/20261126140500_payment_version_guard.sql', import.meta.url), 'utf8'));
    await db.exec(readFileSync(new URL('../../supabase/migrations/20261126141700_payment_delete_version_guard.sql', import.meta.url), 'utf8'));
    for (const [fn, table, kind] of [['delete_payment_received_guarded','payments_received','invoice'],['delete_payment_made_guarded','payments_made','bill']]) {
      const version=(await db.query(`select updated_at::text as version from public.${table} where id='P'`)).rows[0].version;
      await assert.rejects(()=>db.query(`select public.${fn}($1)`,['P']), /PAYMENT_VERSION_REQUIRED/);
      await assert.rejects(()=>db.query(`select public.${fn}($1,$2)`,['P','2020-01-01T00:00:00Z']), /PAYMENT_VERSION_CONFLICT/);
      await assert.rejects(()=>db.query(`select public.${fn}($1,$2)`,['P','not-a-date']), /PAYMENT_VERSION_REQUIRED/);
      await db.exec("select set_config('test.role','sales',false)");
      await assert.rejects(()=>db.query(`select public.${fn}($1,$2)`,['P',version]), /Only active admin/);
      await db.exec("select set_config('test.role','admin',false)");
      assert.equal((await db.query(`select count(*)::int as n from public.${table} where id='P'`)).rows[0].n,1);
      const deleted=await db.query(`select public.${fn}($1,$2) result`,['P',version]);
      assert.equal(deleted.rows[0].result.deleted,true);
      assert.equal(deleted.rows[0].result[kind].id,'A');
      assert.equal((await db.query(`select count(*)::int as n from public.${table} where id='P'`)).rows[0].n,0);
    }
    const log=await db.query('select kind, document_id from public.recalc_log order by kind');
    assert.deepEqual(log.rows,[{kind:'bill',document_id:'A'},{kind:'invoice',document_id:'A'}]);
    await assert.rejects(()=>db.query('select public.delete_payment_received_guarded($1,$2)',['FOREIGN','2020-01-01']), /Received payment was not found/);
  } finally { await db.close(); }
});
