import {requireShadowStagingHost} from './shadow-batch-contract.mjs';

export const PRODUCTION_SUPABASE_HOST='zjgueqijumzlfioihnkt.supabase.co';
const DEFAULT_STAGING_HOST='ztzxxogozgaojgabnvpg.supabase.co';

// Production is a separate operational service, never an expanded staging
// allowlist. Fixture, expiry and operator tools retain their staging guard.
export function requireSupplierPriceServiceTarget(env) {
  const environment=env.SUPPLIER_PRICE_TARGET_ENVIRONMENT||'staging';
  if(!['staging','production'].includes(environment))throw Error('SERVICE_TARGET_ENVIRONMENT_REQUIRED');
  const production=environment==='production';
  if(production&&env.SUPPLIER_PRICE_PRODUCTION_ENABLED!=='1')
    throw Object.assign(Error('SERVICE_OPT_IN_REQUIRED'),{configKey:'SUPPLIER_PRICE_PRODUCTION_ENABLED'});
  if(!production&&env.SUPPLIER_PRICE_PRODUCTION_ENABLED&&env.SUPPLIER_PRICE_PRODUCTION_ENABLED!=='0')
    throw Error('SERVICE_PRODUCTION_TARGET_REQUIRED');
  const expectedHost=production?PRODUCTION_SUPABASE_HOST:env.SUPPLIER_PRICE_EXPECTED_HOST||DEFAULT_STAGING_HOST;
  if(production&&env.SUPPLIER_PRICE_EXPECTED_HOST!==PRODUCTION_SUPABASE_HOST)
    throw Error('SERVICE_PRODUCTION_TARGET_REQUIRED');
  let url;
  try{url=new URL(env.SUPABASE_URL||'https://invalid.invalid');}
  catch{throw Error(production?'SERVICE_PRODUCTION_TARGET_REQUIRED':'SHADOW_PERSIST_STAGING_HOST_REQUIRED');}
  if(production) {
    if(url.protocol!=='https:'||url.host!==PRODUCTION_SUPABASE_HOST||url.username||url.password)
      throw Error('SERVICE_PRODUCTION_TARGET_REQUIRED');
  } else requireShadowStagingHost(url.href,expectedHost);
  // Compare the supplied origin too: URL normalization must not hide /x/..
  // or an empty query/hash in a supposedly exact API origin.
  if(![url.origin,url.origin+'/'].includes(env.SUPABASE_URL))
    throw Error(production?'SERVICE_PRODUCTION_TARGET_REQUIRED':'SERVICE_STAGING_ORIGIN');
  return Object.freeze({environment,origin:url.origin,expectedHost});
}

export function requireProductionServiceInvocation(env,argument) {
  let productionHost=false;
  try{productionHost=new URL(env.SUPABASE_URL||'https://invalid.invalid').hostname===PRODUCTION_SUPABASE_HOST;}
  catch{} // Config gives the bounded diagnosis; no raw URL is logged.
  const approvedProductionRecovery = argument === '--operator-recover-production'
    && env.SUPPLIER_PRICE_OPERATOR_RECOVERY_APPROVED === '1'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.SUPPLIER_PRICE_OPERATOR_RECOVERY_RELEASE_ID || '')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.SUPPLIER_PRICE_OPERATOR_RECOVERY_HANDOFF_ID || '');
  if(approvedProductionRecovery) return;
  if(argument!=='--service'&&(productionHost||env.SUPPLIER_PRICE_TARGET_ENVIRONMENT==='production'
    ||env.SUPPLIER_PRICE_PRODUCTION_ENABLED==='1'))throw Error('SERVICE_PRODUCTION_SERVICE_REQUIRED');
}

export function requireProductionServiceCredential(key,expectedHost) {
  if(/^sb_secret_[A-Za-z0-9_-]+$/.test(key||''))return;
  try{
    const segments=String(key||'').split('.');
    if(segments.length!==3||segments.some(segment=>! /^[A-Za-z0-9_-]+$/.test(segment)))throw Error();
    const header=JSON.parse(Buffer.from(segments[0],'base64url').toString('utf8'));
    const claims=JSON.parse(Buffer.from(segments[1],'base64url').toString('utf8'));
    if(header.alg!=='HS256'||claims.role!=='service_role'||claims.ref!==expectedHost.split('.')[0]
      ||!Number.isFinite(claims.exp)||claims.exp<=Date.now()/1000)throw Error();
  }catch{throw Error('SERVICE_PRODUCTION_SECRET_REQUIRED');}
  // Decoding is a target/role syntax guard, not JWT authentication. The exact
  // service-only API capability probe must authenticate it before DBOS launch.
}
