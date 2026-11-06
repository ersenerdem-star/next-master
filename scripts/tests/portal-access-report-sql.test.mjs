import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const migrationUrl=new URL('../../supabase/migrations/20261106122842_portal_access_report.sql',import.meta.url);
const org='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002';
const actor='20000000-0000-4000-8000-000000000001';
const invite='30000000-0000-4000-8000-000000000001', foreignInvite='30000000-0000-4000-8000-000000000002';
const uid=n=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const from='2026-11-01T00:00:00Z',to='2026-11-07T00:00:00Z',asOf='2026-11-06T12:00:00Z';

async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;
 create function auth.uid()returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function public.current_profile_org_id()returns uuid language sql as $$select nullif(current_setting('test.org',true),'')::uuid$$;
 create function public.current_profile_role()returns text language sql as $$select current_setting('test.role',true)$$;
 create function public.is_superadmin()returns boolean language sql as $$select current_setting('test.role',true)='superadmin'$$;
 create function public.profile_has_permission(v text)returns boolean language sql as $$select true$$;
 create table organizations(id uuid primary key);
 create table portal_invites(id uuid primary key,organization_id uuid,party_type text,party_name text,email text,status text);
 create table portal_audit_logs(id uuid primary key,organization_id uuid,invite_id uuid,party_type text,email text,event_type text,status text,
 ip_address text,user_agent text,details jsonb,created_at timestamptz not null);
 alter table portal_audit_logs enable row level security;
 select set_config('test.uid','${actor}',false);select set_config('test.org','${org}',false);select set_config('test.role','admin',false);
 insert into organizations values('${org}'),('${other}');
 insert into portal_invites values('${invite}','${org}','customer','Own Customer','user@example.invalid','active'),
 ('${foreignInvite}','${other}','customer','Foreign Customer','foreign@example.invalid','active');`);
 const migration=await readFile(migrationUrl,'utf8');assert.ok(migration.includes('admin_portal_access_report'),'report migration must exist');
 await db.exec(migration);
 const seed=async(n,patch={})=>{
  const row={organization_id:org,invite_id:invite,party_type:'customer',email:'user@example.invalid',event_type:'portal_login',status:'ok',ip_address:'203.0.113.8',user_agent:'test-agent',details:{auth_method:'password',sessionToken:'NEVER_RETURN_SECRET'},created_at:`2026-11-05T10:00:${String(n).padStart(2,'0')}Z`,country_code:'TR',country_source:'netlify_geo',...patch};
  await db.query(`insert into portal_audit_logs(id,organization_id,invite_id,party_type,email,event_type,status,ip_address,user_agent,details,created_at,country_code,country_source)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[uid(n),...Object.values(row)]);
 };
 await seed(1,{details:{},country_code:null,country_source:null});
 await seed(2,{event_type:'portal_session_resume',details:{auth_method:'session'}});
 await seed(3,{event_type:'portal_logout',country_code:'DE',details:{auth_method:'session'}});
 await seed(4,{event_type:'portal_session_rejected',status:'failed',details:{reason:'invalid_or_expired',password:'NEVER_RETURN_PASSWORD'}});
 await seed(5,{organization_id:other,invite_id:foreignInvite,email:'foreign@example.invalid'});
 await seed(6,{organization_id:null,invite_id:null,email:'unscoped@example.invalid'});
 await seed(7,{event_type:'portal_search'});
 await seed(8,{created_at:'2026-11-06T12:00:00Z'});
 await seed(9,{invite_id:foreignInvite,email:'mismatched@example.invalid'});
 const report=async(patch={})=>{
  const x={from,to,page:1,pageSize:50,search:'',inviteId:null,event:'',status:'',country:'',asOf,...patch};
  return (await db.query('select admin_portal_access_report($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result',Object.values(x))).rows[0].result;
 };
 return {db,seed,report};
}

test('access report scopes events and names to the administrator organization and exposes only safe columns',async t=>{
 const {report}=await fixture(t),r=await report();
 assert.equal(r.total,5);assert.equal(r.rows.length,5);
 assert.deepEqual(r.rows.map(x=>x.id),[9,4,3,2,1].map(uid));
 assert.equal(r.rows.find(x=>x.id===uid(1)).party_name,'Own Customer');
 assert.notEqual(r.rows.find(x=>x.id===uid(9)).party_name,'Foreign Customer');
 assert.doesNotMatch(JSON.stringify(r),/Foreign Customer|foreign@example|unscoped@example|NEVER_RETURN|sessionToken|password|test-agent/);
 assert.equal(r.rows.find(x=>x.id===uid(4)).reason,'invalid_or_expired');
 assert.equal(r.rows.find(x=>x.id===uid(1)).is_legacy,true);
 assert.equal(r.rows.find(x=>x.id===uid(2)).is_legacy,false);
 assert.ok(r.parties.every(x=>x.id!==foreignInvite));
});

test('country, event, status and user filters retain unknown geography and never infer historical logout',async t=>{
 const {report}=await fixture(t);
 assert.deepEqual((await report({country:'DE'})).rows.map(x=>x.id),[uid(3)]);
 const unknown=await report({country:'__unknown__'});assert.equal(unknown.total,1);assert.equal(unknown.rows[0].country_code,null);
 assert.equal((await report({event:'portal_logout'})).total,1);
 assert.equal((await report({status:'failed'})).total,1);
 assert.equal((await report({search:'mismatched@'})).total,1);
 const r=await report();assert.ok(r.countries.some(x=>x.code==='TR'));assert.ok(r.countries.some(x=>x.code==='DE'));
});

test('as-of boundary keeps pagination stable while newer access events arrive',async t=>{
 const {report,seed}=await fixture(t);
 const p1=await report({pageSize:2});assert.equal(p1.rows.length,2);
 await seed(10,{created_at:'2026-11-06T12:00:01Z'});
 const p2=await report({page:2,pageSize:2,asOf:p1.asOf});
 assert.equal(p2.total,p1.total);
 assert.equal(new Set([...p1.rows,...p2.rows].map(x=>x.id)).size,4);
 assert.equal((await report({from:'2026-11-05T10:00:03Z',to:'2026-11-05T10:00:04Z'})).total,1);
});

test('authorization and validated filters prevent unrestricted audit access',async t=>{
 const {db,report}=await fixture(t);
 for(const role of ['sales','viewer','']){
  await db.query("select set_config('test.role',$1,false)",[role]);await assert.rejects(report());
 }
 await db.exec("select set_config('test.role','admin',false);select set_config('test.uid','',false)");await assert.rejects(report());
 await db.exec(`select set_config('test.uid','${actor}',false);select set_config('test.org','',false)`);await assert.rejects(report());
 await db.query("select set_config('test.org',$1,false)",[org]);
 await db.exec(`select set_config('test.uid','${actor}',false);select set_config('test.role','superadmin',false)`);
 assert.equal((await report()).total,5);
 for(const patch of [{from:to,to:from},{from:'2020-01-01T00:00:00Z'},{event:'portal_search'},{status:'anything'},{country:'TURKEY'}])await assert.rejects(()=>report(patch));
 await db.exec('set role anon');await assert.rejects(report(),/permission denied/);await assert.rejects(()=>db.query('select * from portal_audit_logs'),/permission denied/);
});
