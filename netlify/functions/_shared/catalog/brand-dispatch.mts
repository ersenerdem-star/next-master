import {createHmac,timingSafeEqual} from 'node:crypto';
export const brandDispatchSignature=(key:string,job:string,org:string,time:string)=>createHmac('sha256',key).update(`catalog-brand-engine-v1\n${job}\n${org}\n${time}`).digest('hex');
export function requireBrandDispatch(req:Request,key:string,job:string,org:string){const t=req.headers.get('x-catalog-time')||'',s=req.headers.get('x-catalog-signature')||'';
 if(!/^[a-f0-9-]{36}$/i.test(job)||!/^[a-f0-9-]{36}$/i.test(org)||!/^\d{13}$/.test(t)||Math.abs(Date.now()-Number(t))>90000||!/^[a-f0-9]{64}$/.test(s)||!timingSafeEqual(Buffer.from(s,'hex'),Buffer.from(brandDispatchSignature(key,job,org,t),'hex')))throw Error('BRAND_DISPATCH_DENIED');}
