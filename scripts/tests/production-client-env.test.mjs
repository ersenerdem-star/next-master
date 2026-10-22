import {test} from 'node:test';
import assert from 'node:assert/strict';
import {productionClientEnvironment} from '../ops/build-production-client.mjs';
const target='https://zjgueqijumzlfioihnkt.supabase.co';
test('production build retains every resolved public feature flag and excludes backend settings and stale inherited flags',()=>{
 const env=productionClientEnvironment({VITE_SUPABASE_URL:target,VITE_SUPPLIER_CATALOG_ENRICHMENT_ENABLED:'true',VITE_SUPPLIER_RELEASE_REVIEW_ENABLED:'true',VITE_FUTURE_PUBLIC_FLAG:'false',SUPABASE_SERVICE_ROLE_KEY:'backend-only'},{PATH:'/test',VITE_STALE_LOCAL_FLAG:'true'});
 assert.equal(env.VITE_SUPPLIER_CATALOG_ENRICHMENT_ENABLED,'true');assert.equal(env.VITE_SUPPLIER_RELEASE_REVIEW_ENABLED,'true');assert.equal(env.VITE_FUTURE_PUBLIC_FLAG,'false');assert.equal(env.SUPABASE_SERVICE_ROLE_KEY,undefined);assert.equal(env.VITE_STALE_LOCAL_FLAG,undefined);assert.equal(env.PATH,'/test');assert.equal(env.CONTEXT,'production');
});
test('wrong project and private credentials under a public prefix refuse a production client build',()=>{
 assert.throws(()=>productionClientEnvironment({VITE_SUPABASE_URL:'https://example.supabase.co'}),/TARGET_MISMATCH/);
 for(const extra of [{VITE_SERVICE_ROLE_KEY:'private'},{VITE_OTHER_TOKEN:'sb_secret_private'},{VITE_OTHER_TOKEN:'e30.'+Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')+'.sig'}])assert.throws(()=>productionClientEnvironment({VITE_SUPABASE_URL:target,...extra}),/NOT_PUBLIC/);
});
