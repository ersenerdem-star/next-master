import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const setup = readFileSync(new URL('../../tests/sql/bill_integrity_setup.sql', import.meta.url), 'utf8');
const initial = readFileSync(new URL('../../supabase/migrations/20260707_95_invoice_bill_guarded_boundary.sql', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../../supabase/migrations/20261126143500_bill_version_guard.sql', import.meta.url), 'utf8');
async function fixture() {
  const db = new PGlite(); await db.exec(setup);
  const start=initial.indexOf('create or replace function public.save_bill_atomic(');
  const end=initial.indexOf('grant execute on function public.save_invoice_atomic',start);
  await db.exec(initial.slice(start,end)); await db.exec(migration); return db;
}
const payload=(id,more={})=>({id,purchase_order_id:'PO1',currency:'EUR',status:'draft',lines:[{qty:2,buy_price:5}],...more});
test('same-PO partial bills create independently; duplicate and stale changes are rejected',async()=>{
  const db=await fixture(); try {
    const privileges=(await db.query("select has_table_privilege('authenticated','public.bills','INSERT') i, has_table_privilege('authenticated','public.bills','UPDATE') u, has_table_privilege('authenticated','public.bills','TRUNCATE') t, has_table_privilege('authenticated','public.payments_made','TRIGGER') p")).rows[0];
    assert.deepEqual(privileges,{i:true,u:false,t:false,p:false});
    for (const table of ['bills','payments_received','payments_made']) {
      for (const privilege of ['TRUNCATE','REFERENCES','TRIGGER']) {
        const access=await db.query('select has_table_privilege($1,$2,$3) as allowed',['authenticated',table,privilege]);
        assert.equal(access.rows[0].allowed,false,`${table}: ${privilege}`);
      }
      const service=await db.query('select has_table_privilege($1,$2,$3) as allowed',['service_role',table,'UPDATE']);
      assert.equal(service.rows[0].allowed,true);
    }
    const version=(await db.query("select updated_at::text version from bills where id='B1'")).rows[0].version;
    await assert.rejects(()=>db.query('select public.save_bill_atomic($1::jsonb,$2)',[JSON.stringify(payload('B1')),null]),/BILL_NUMBER_ALREADY_USED/);
    await assert.rejects(()=>db.query('select public.save_bill_atomic($1::jsonb,$2)',[JSON.stringify(payload('B1')),'B1']),/BILL_VERSION_REQUIRED/);
    await assert.rejects(()=>db.query('select public.save_bill_atomic($1::jsonb,$2)',[JSON.stringify(payload('B1',{expected_updated_at:'2020-01-01'})),'B1']),/BILL_VERSION_CONFLICT/);
    for(const id of ['B2','B3']) await db.query('select public.save_bill_atomic($1::jsonb,$2)',[JSON.stringify(payload(id)),null]);
    assert.equal((await db.query("select count(*)::int n from bills where purchase_order_id='PO1'")).rows[0].n,3);
    await assert.rejects(()=>db.query("insert into bills(id,organization_id) values(' b 2 ','00000000-0000-0000-0000-000000000001')"),/BILL_NUMBER_ALREADY_USED/);
    const result=await db.query('select public.save_bill_atomic($1::jsonb,$2) result',[JSON.stringify(payload('B1',{expected_updated_at:version})),'B1']);
    assert.equal(Number(result.rows[0].result.bill.total_amount),10);
    await assert.rejects(()=>db.query('select public.save_bill_atomic($1::jsonb,$2)',[JSON.stringify(payload('B1',{expected_updated_at:version})),'B1']),/BILL_VERSION_CONFLICT/);
    await assert.rejects(()=>db.query('select public.save_bill_atomic($1::jsonb,$2)',[JSON.stringify(payload('B2',{expected_updated_at:version})),'B1']),/BILL_VERSION_CONFLICT/);
  }finally{await db.close()}
});
test('delete requires a fresh version and retains original posted/payment rules',async()=>{
  const db=await fixture(); try {
    let version=(await db.query("select updated_at::text version from bills where id='B1'")).rows[0].version;
    await assert.rejects(()=>db.query('select public.delete_bill_guarded($1)',['B1']),/BILL_VERSION_REQUIRED/);
    await assert.rejects(()=>db.query('select public.delete_bill_guarded($1,$2)',['B1','2020-01-01']),/BILL_VERSION_CONFLICT/);
    await db.exec("insert into payments_made values('P','00000000-0000-0000-0000-000000000001','B1')");
    await assert.rejects(()=>db.query('select public.delete_bill_guarded($1,$2)',['B1',version]),/Delete linked payments first/);
    await db.exec("delete from payments_made where id='P'; update bills set status='confirmed' where id='B1'");
    await assert.rejects(()=>db.query('select public.delete_bill_guarded($1,$2)',['B1',version]),/Posted bills cannot be deleted/);
    await db.exec("update bills set status='draft' where id='B1'; select set_config('test.role','sales',false)");
    await assert.rejects(()=>db.query('select public.delete_bill_guarded($1,$2)',['B1',version]),/Only active admin/);
    await db.exec("select set_config('test.role','admin',false)");
    const result=await db.query('select public.delete_bill_guarded($1,$2) result',['B1',version]);assert.equal(result.rows[0].result.deleted,true);
  }finally{await db.close()}
});
