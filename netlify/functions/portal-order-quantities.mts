import type { Config, Context } from '@netlify/functions';
import { json } from './_shared/http.mts';
import { resolvePortalInvite } from './_shared/portal-access.mts';
import { preparePortalOrderLines } from './_shared/portal-orders.mts';
import { PortalQuantityPriceError, savePortalQuantities } from './_shared/portal-quantity-autosave.mts';
import { enforcePortalRateLimit } from './_shared/portal-rate-limit.mts';
import { buildPortalSessionCookie, readPortalSessionCookie } from './_shared/portal-security.mts';
import { getPortalRequestHostname } from './_shared/portal-tenant.mts';
import { sanitizeUserFacingError } from './_shared/user-message.mts';

export default async (req: Request, _context: Context) => {
  if (req.method !== 'POST') return json({error:'Method not allowed'},405);
  const url=Netlify.env.get('SUPABASE_URL'), key=Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json({error:'System configuration is incomplete.'},500);
  try {
    const body=await req.json();
    const email=String(body?.email || '').trim(), password=String(body?.password || '').trim();
    const token=String(body?.sessionToken || readPortalSessionCookie(req) || '').trim();
    if (!token && (!email || !password)) return json({error:'Email and password are required'},400);
    const rate=await enforcePortalRateLimit(req,url,key,'quantity_autosave',email);
    if (!rate.allowed) return json({error:'Too many quantity updates. Please try again later.'},429,{'Retry-After':String(rate.retryAfterSeconds)});
    const {invite, sessionToken}=await resolvePortalInvite(url,key,Netlify.env.get('PORTAL_SESSION_SECRET') || key,{email,password,sessionToken:token,hostname:getPortalRequestHostname(req)});
    const result=await savePortalQuantities(url,key,invite,String(body?.orderId || ''),String(body?.updatedAt || ''),Array.isArray(body?.edits) ? body.edits : [],
      async rows => (await preparePortalOrderLines(url, key, invite, rows, {
        savedSuppliers: rows.map(row => row.savedSupplier),
      })).lines,
    );
    return json({ok:true,...result},200,{'Set-Cookie':buildPortalSessionCookie(sessionToken)});
  } catch (error) {
    if (error instanceof PortalQuantityPriceError) {
      return json({error:error.message,blockedLine:{number:error.lineNumber,code:error.code}},409);
    }
    return json({error:sanitizeUserFacingError(error,'Quantity update failed')},400);
  }
};
export const config: Config = {path:'/api/portal-order-quantities',method:'POST'};
