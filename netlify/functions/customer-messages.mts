import type {Config,Context} from '@netlify/functions';
import {createMessagesHandler} from './_shared/customer-messages.mts';
import {json} from './_shared/http.mts';
export default async(req:Request,_context:Context)=>{
  const url=Netlify.env.get('SUPABASE_URL'),anonKey=Netlify.env.get('SUPABASE_ANON_KEY'),serviceKey=Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if(!url||!anonKey||!serviceKey)return json({error:'Messages are unavailable.'},503);
  return createMessagesHandler(new URL(req.url).pathname==='/api/portal-messages',{url,anonKey,serviceKey,sessionSecret:Netlify.env.get('PORTAL_SESSION_SECRET')||serviceKey})(req);
};
export const config:Config={path:['/api/customer-messages','/api/portal-messages'],method:'POST'};
