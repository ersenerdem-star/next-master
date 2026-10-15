import {supabaseClient} from './supabaseClient';
export type CustomerMessage={id:string;sender_kind:'admin'|'customer';sender_name:string;body:string;created_at:string;read_at:string|null};
export type MessageCursor={createdAt:string;id:string};
export type MessageCustomer={id:string;name:string};
export type MessageConversation={customer_id:string;customer_name:string;last_message_at:string;unread_count:number};
export async function messagingRequest<T>(portal:boolean,payload:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
  const headers:Record<string,string>={'Content-Type':'application/json'};
  if(!portal){const {data,error}=await supabaseClient.auth.getSession();if(error||!data.session)throw Error('Sign in again.');headers.Authorization=`Bearer ${data.session.access_token}`;}
  const response=await fetch(portal?'/api/portal-messages':'/api/customer-messages',{method:'POST',credentials:'same-origin',cache:'no-store',headers,body:JSON.stringify(payload),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'Messages could not be loaded.');
  return data as T;
}
