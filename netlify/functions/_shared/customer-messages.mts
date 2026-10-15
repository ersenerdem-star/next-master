import {buildRestUrl,getJson,sendJson,serviceRoleHeaders,HttpRequestError,json} from './http.mts';
import {resolveCaller,getAppAuthStatus} from './app-auth.mts';
import {resolvePortalInvite} from './portal-access.mts';
import {readPortalSessionCookie} from './portal-security.mts';
import {getPortalRequestHostname} from './portal-tenant.mts';

const uuid=(v:unknown)=>typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const messageSelect='id,sender_kind,sender_name,body,created_at,read_at';
type Identity={organizationId:string;customerId?:string;senderId:string;senderName:string;kind:'admin'|'customer'};
export type MessagingConfig={url:string;anonKey:string;serviceKey:string;sessionSecret:string};
export async function resolveMessagingIdentity(req:Request,portal:boolean,config:MessagingConfig):Promise<Identity>{
  if(portal){
    const token=readPortalSessionCookie(req);
    if(!token)throw new Error('MESSAGING_UNAUTHENTICATED');
    let invite;
    try{({invite}=await resolvePortalInvite(config.url,config.serviceKey,config.sessionSecret,{sessionToken:token,hostname:getPortalRequestHostname(req),touchSession:false}));}
    catch{throw new Error('MESSAGING_UNAUTHENTICATED');}
    if(invite.party_type!=='customer'||!invite.customer_id)throw new Error('MESSAGING_FORBIDDEN');
    return {organizationId:invite.organization_id,customerId:invite.customer_id,senderId:invite.id,senderName:(invite.contact_name||invite.party_name||'Customer').slice(0,180),kind:'customer'};
  }
  const caller=await resolveCaller(req,config.url,config.anonKey,config.serviceKey);
  if(!['admin','superadmin'].includes(caller.role))throw new Error('MESSAGING_FORBIDDEN');
  return {organizationId:caller.organizationId,senderId:caller.id,senderName:(caller.fullName||caller.email||'Admin').slice(0,180),kind:'admin'};
}

export function createMessagesHandler(portal:boolean,config:MessagingConfig,resolveIdentity=resolveMessagingIdentity){
  return async(req:Request)=>{
    const reply=(data:unknown,status=200)=>json(data,status,{'Cache-Control':'no-store'});
    if(req.method!=='POST')return reply({error:'Method not allowed'},405);
    if(!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return reply({error:'JSON required'},415);
    const origin=req.headers.get('origin');
    if((portal && !origin)||(origin && origin!==new URL(req.url).origin))return reply({error:'Request origin is not allowed.'},403);
    try{
      // Authenticate before querying any customer/message data. Browser-supplied
      // tenant, sender and (for portal callers) customer IDs are never trusted.
      const identity=await resolveIdentity(req,portal,config);
      const raw=await req.text();
      if(raw.length>16000)return reply({error:'Message request is too large.'},413);
      let body:Record<string,unknown>;
      try{body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{return reply({error:'Invalid request.'},400);}
      const headers=serviceRoleHeaders(config.serviceKey);
      const read=<T,>(table:string,params:Record<string,string>)=>getJson<T>(buildRestUrl(config.url,table,params),{headers,timeoutMs:8000});
      const rpc=<T,>(name:string,args:unknown)=>sendJson<T>(`${config.url}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(args),timeoutMs:8000});
      if(body.action==='inbox' && !portal){
        const search=String(body.search||'').trim().slice(0,80);
        // Restrict search to a simple substring; never interpolate REST syntax.
        const customers=await read<Array<{id:string;display_name:string;company_name:string}>>('customers',{
          select:'id,display_name,company_name',organization_id:`eq.${identity.organizationId}`,
          ...(search?{display_name:`ilike.*${search.replace(/[^\p{L}\p{N}\s.-]/gu,'')}*`}:{}),order:'display_name.asc,id.asc',limit:'200'});
        const conversations=await rpc<unknown[]>('customer_message_inbox',{p_organization_id:identity.organizationId});
        return reply({customers:customers.map(c=>({id:c.id,name:c.display_name||c.company_name||'Customer'})),conversations});
      }
      if(!['list','send','read'].includes(String(body.action)))return reply({error:'Unknown message action.'},400);
      const customerId=portal?identity.customerId:body.customerId;
      if(!uuid(customerId))return reply({error:'Choose a customer.'},400);
      const scope={organization_id:`eq.${identity.organizationId}`,customer_id:`eq.${customerId}`};
      const customers=await read<unknown[]>('customers',{select:'id',organization_id:scope.organization_id,id:`eq.${customerId}`,limit:'1'});
      if(!customers.length)return reply({error:'Customer not available.'},404);
      if(body.action==='send'){
        if(!uuid(body.id)||typeof body.text!=='string'||!body.text.trim()||[...body.text.trim()].length>4000)return reply({error:'Enter a message of up to 4,000 characters.'},400);
        const sent=await rpc<Record<string,unknown>|Record<string,unknown>[]>('send_customer_message',{p_organization_id:identity.organizationId,p_customer_id:customerId,p_id:body.id,p_sender_kind:identity.kind,p_sender_id:identity.senderId,p_sender_name:identity.senderName,p_body:body.text.trim()});
        const message=Array.isArray(sent)?sent[0]:sent;
        if(!message || message.id!==body.id)throw new Error("Message receipt could not be verified");
        return reply({message});
      }
      let cursor: {createdAt:string;id:string}|null=null;
      if(body.before || body.through){
        const value=(body.before||body.through) as Record<string,unknown>;
        if(!uuid(value.id)||typeof value.createdAt!=='string'||!/^\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(value.createdAt)||!Number.isFinite(Date.parse(value.createdAt)))return reply({error:'Invalid message cursor.'},400);
        cursor={createdAt:value.createdAt,id:value.id as string};
      }
      if(body.action==='read'){
        if(!cursor)return reply({error:'Read cursor required.'},400);
        const atOrBefore=`(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lte.${cursor.id}))`;
        await sendJson(buildRestUrl(config.url,'customer_messages',{...scope,sender_kind:`eq.${portal?'admin':'customer'}`,read_at:'is.null',or:atOrBefore}),{method:'PATCH',headers,body:JSON.stringify({read_at:new Date().toISOString()}),timeoutMs:8000});
        return reply({ok:true});
      }
      const messages=await read<Array<{id:string;created_at:string}>>('customer_messages',{select:messageSelect,...scope,order:'created_at.desc,id.desc',limit:'51',...(cursor?{or:`(created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id}))`}:{})});
      const page=messages.slice(0,50),last=page.at(-1);
      return reply({messages:page.reverse(),next:messages.length>50&&last?{createdAt:last.created_at,id:last.id}:null});
    }catch(error){
      const status=getAppAuthStatus(error);
      if(status)return reply({error:status===401?'Sign in again.':'Messaging access denied.'},status);
      if(error instanceof Error && error.message==='MESSAGING_UNAUTHENTICATED')return reply({error:'Sign in again.'},401);
      if(error instanceof Error && error.message==='MESSAGING_FORBIDDEN')return reply({error:'Messaging access denied.'},403);
      if(error instanceof HttpRequestError && error.code==='P0001')return reply({error:'Too many messages. Wait a minute and try again.'},429);
      if(error instanceof HttpRequestError && error.code==='22023')return reply({error:'Message could not be accepted. Check the customer and try again.'},400);
      return reply({error:'Messages are unavailable. Your draft has been kept; try again.'},503);
    }
  };
}
