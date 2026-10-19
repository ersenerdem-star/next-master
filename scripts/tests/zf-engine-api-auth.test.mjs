import {test} from 'node:test';import assert from 'node:assert/strict';
import handler from '../../netlify/functions/catalog-zf.mts';
const original=globalThis.fetch;
globalThis.Netlify={env:{get:name=>name==='SUPABASE_URL'?'https://auth.example.invalid':'test-key'}};
test('expired or revoked caller sessions return auth-required, not a generic job failure',async()=>{
 globalThis.fetch=async url=>{assert.match(String(url),/auth\/v1\/user$/);return Response.json({msg:'JWT expired',code:'bad_jwt'},{status:401});};
 try{const response=await handler(new Request('https://portal.example/api/catalog-zf?brand=Sachs',{headers:{authorization:'Bearer expired-test-token'}}));assert.equal(response.status,401);assert.deepEqual(await response.json(),{error:'AUTH_REQUIRED'});}finally{globalThis.fetch=original;}
});
test('missing caller tokens are rejected before source or database access',async()=>{
 globalThis.fetch=async()=>{throw Error('unexpected source/database read');};
 try{const response=await handler(new Request('https://portal.example/api/catalog-zf?brand=Sachs'));assert.equal(response.status,401);}finally{globalThis.fetch=original;}
});
