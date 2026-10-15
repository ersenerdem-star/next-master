import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createMessagesHandler} from '../../netlify/functions/_shared/customer-messages.mts';
import {createPortalSessionToken,buildPortalSessionCookie} from '../../netlify/functions/_shared/portal-security.mts';
const org='10000000-0000-4000-8000-000000000001',customer='20000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002',actor='30000000-0000-4000-8000-000000000001',id='40000000-0000-4000-8000-000000000001';
const config={url:'https://fixture.supabase.co',anonKey:'fixture-anon',serviceKey:'fixture-service',sessionSecret:'fixture-secret'};
const migration=await readFile(new URL('../../supabase/migrations/20261015125102_customer_admin_messaging.sql',import.meta.url),'utf8');

test('actual SQL enforces service-only storage, idempotency, customer/tenant binding and unread state',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create table public.customers(id uuid primary key,organization_id uuid,display_name text,company_name text);grant select on public.customers to service_role;
    insert into public.customers values('${customer}','${org}','First customer',''),('${other}','10000000-0000-4000-8000-000000000002','Other tenant','');`);
  await db.exec(migration);
  for(const role of ['anon','authenticated']){
   await db.exec(`set role ${role}`);
   await assert.rejects(db.query('select * from public.customer_messages'),/permission denied/);
   await assert.rejects(db.query(`select public.customer_message_inbox('${org}')`),/permission denied/);
   await assert.rejects(db.query(`select public.send_customer_message('${org}','${customer}','${id}','admin','${actor}','Admin','blocked')`),/permission denied/);
   await db.exec('reset role');
  }
  await db.exec('set role service_role');
  const send=(mid:string,cid=customer,oid=org,body='Hello',kind='customer')=>db.query(`select (public.send_customer_message($1::uuid,$2::uuid,$3::uuid,$4,$5::uuid,'Account',$6)).*`,[oid,cid,mid,kind,actor,body]);
  const first=await send(id),replay=await send(id);assert.equal(first.rows.length,1);assert.deepEqual(first.rows,replay.rows);
  assert.equal((await db.query('select count(*)::int n from public.customer_messages')).rows[0].n,1);
  await assert.rejects(send(id,customer,org,'Changed text'),/reference conflict/);
  await assert.rejects(send(crypto.randomUUID(),other),/Customer not available/);
  await assert.rejects(send(crypto.randomUUID(),customer,org,' '.repeat(2)),/Invalid message/);
  await assert.rejects(send(crypto.randomUUID(),customer,org,'x'.repeat(4001)),/Invalid message/);
  assert.equal((await db.query(`select * from public.customer_message_inbox('${org}')`)).rows[0].unread_count,1);
  assert.equal((await db.query(`select * from public.customer_message_inbox('10000000-0000-4000-8000-000000000002')`)).rows.length,0);
  await db.exec(`update public.customer_messages set read_at=now() where organization_id='${org}' and customer_id='${customer}' and sender_kind='customer'`);
  assert.equal((await db.query(`select * from public.customer_message_inbox('${org}')`)).rows[0].unread_count,0);
  for(let i=1;i<20;i++)await send(crypto.randomUUID());
  await assert.rejects(send(crypto.randomUUID()),/rate limit/);
  assert.equal((await send(id)).rows.length,1);
 }finally{await db.close();}
});

async function gateway(options:{portal?:boolean;role?:string;active?:boolean;inviteStatus?:string;inviteParty?:string;orgMismatch?:boolean}={},run:(request:(body:unknown,extra?:Record<string,string>)=>Promise<Response>,calls:any[])=>Promise<void>){
 const previous=globalThis.fetch,calls:any[]=[];
 const portal=Boolean(options.portal),updated='2026-10-15T10:00:00Z';
 const token=await createPortalSessionToken(config.sessionSecret,actor,'customer@example.test',org,'portal.fixture.test',updated);
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));calls.push({url:u,init,body:init?.body?JSON.parse(String(init.body)):undefined});
  if(u.pathname==='/auth/v1/user')return Response.json({id:actor,email:'admin@example.test'});
  if(u.pathname==='/rest/v1/profiles')return Response.json([{organization_id:org,role:options.role||'admin',full_name:'Real Admin',is_active:options.active!==false,permissions:{},session_revoked_at:null}]);
  if(u.pathname==='/rest/v1/portal_seller_domains')return Response.json([{id:actor,organization_id:org,seller_company_profile_id:null,hostname:'portal.fixture.test'}]);
  if(u.pathname==='/rest/v1/portal_invites')return Response.json([{id:actor,organization_id:options.orgMismatch?'10000000-0000-4000-8000-000000000002':org,customer_id:customer,party_type:options.inviteParty||'customer',status:options.inviteStatus||'active',updated_at:updated,email:'customer@example.test',contact_name:'Portal Customer'}]);
  if(u.pathname==='/rest/v1/customers')return Response.json([{id:customer,display_name:'First customer'}]);
  if(u.pathname==='/rest/v1/customer_messages')return Response.json(init?.method==='PATCH'?null:[]);
  if(u.pathname==='/rest/v1/rpc/customer_message_inbox')return Response.json([]);
  if(u.pathname==='/rest/v1/rpc/send_customer_message')return Response.json({id,...calls.at(-1).body});
  throw Error(`Unexpected request: ${u.pathname}`);
 };
 try{
  const handler=createMessagesHandler(portal,config);
  await run((body,extra={})=>handler(new Request(`https://portal.fixture.test/api/${portal?'portal':'customer'}-messages`,{method:'POST',headers:{'content-type':'application/json',origin:'https://portal.fixture.test',host:'portal.fixture.test',...(portal?{cookie:buildPortalSessionCookie(token).split(';')[0]}:{Authorization:'Bearer fixture-token'}),...extra},body:JSON.stringify(body)})),calls);
 }finally{globalThis.fetch=previous;}
}

test('actual admin auth denies non-admin/inactive callers before any customer data access',async()=>{
 for(const options of [{role:'sales'},{role:'viewer'},{active:false}])await gateway(options,async(request,calls)=>{
  const result=await request({action:'inbox'});assert([401,403].includes(result.status));assert(!calls.some(c=>c.url.pathname.includes('customer')));
 });
});
test('actual portal cookie pins tenant, sender and customer; forged request IDs never control scope',async()=>{
 await gateway({portal:true},async(request,calls)=>{
  const result=await request({action:'send',customerId:other,organizationId:'forged',senderId:'forged',id,text:'Hello'});assert.equal(result.status,200);
  const write=calls.find(c=>c.url.pathname==='/rest/v1/rpc/send_customer_message');
  assert.deepEqual(write.body,{p_organization_id:org,p_customer_id:customer,p_id:id,p_sender_kind:'customer',p_sender_id:actor,p_sender_name:'Portal Customer',p_body:'Hello'});
  assert.equal(calls.filter(c=>c.init?.method==='PATCH').length,0);
 });
 for(const options of [{inviteStatus:'disabled'},{inviteParty:'vendor'},{orgMismatch:true}])await gateway({portal:true,...options},async(request,calls)=>{
  const result=await request({action:'list',customerId:other});assert([401,403].includes(result.status));assert(!calls.some(c=>c.url.pathname==='/rest/v1/customer_messages'));
 });
});
test('origin, forged cursor and portal inbox requests fail closed; read receipts are receiver/scoped',async()=>{
 await gateway({portal:true},async(request,calls)=>{
  assert.equal((await request({action:'send',id,text:'Hello'},{origin:'https://evil.test'})).status,403);assert.equal(calls.length,0);
  assert.equal((await request({action:'inbox'})).status,400);
  assert.equal((await request({action:'list',before:{id,createdAt:'now),organization_id.neq.fake'}})).status,400);
  assert.equal((await request({action:'read',customerId:other,through:{id,createdAt:'2026-10-15T10:00:00Z'}})).status,200);
  const write=calls.find(c=>c.init?.method==='PATCH');assert.equal(write.url.searchParams.get('customer_id'),`eq.${customer}`);assert.equal(write.url.searchParams.get('organization_id'),`eq.${org}`);assert.equal(write.url.searchParams.get('sender_kind'),'eq.admin');assert.equal(write.url.searchParams.get('read_at'),'is.null');
 });
});
test('admin sends with real profile identity and a bounded keyset page, never browser sender values',async()=>{
 await gateway({},async(request,calls)=>{
  assert.equal((await request({action:'send',customerId:customer,id,text:'Admin reply',senderId:other})).status,200);
  const write=calls.find(c=>c.url.pathname.endsWith('/send_customer_message'));assert.equal(write.body.p_sender_kind,'admin');assert.equal(write.body.p_sender_id,actor);assert.equal(write.body.p_sender_name,'Real Admin');
  assert.equal((await request({action:'list',customerId:customer,before:{id,createdAt:'2026-10-15T10:00:00Z'}})).status,200);
  const read=calls.find(c=>c.url.pathname==='/rest/v1/customer_messages');assert.equal(read.url.searchParams.get('limit'),'51');assert.match(read.url.searchParams.get('or'),/id.lt/);assert.equal(read.url.searchParams.get('organization_id'),`eq.${org}`);
 });
});
