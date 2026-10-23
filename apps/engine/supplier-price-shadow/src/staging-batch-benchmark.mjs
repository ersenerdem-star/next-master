// Operator-only benchmark admission. Never imported by the service entrypoint.
// Run inside the existing staging worker; no production credential is accepted.
// Operator first records queue drain/publication baseline and creates the three
// named fixture suppliers through management SQL. The worker's narrowly granted
// service key intentionally cannot SELECT the private release ledger.
import { createHash } from 'node:crypto';

export const BENCHMARK_ROWS = 50003;
export function benchmarkCsv() {
  const lines = ['Product_Code,Brand,Buy_Price_Eur,Origin,Tariff,Market_Segment,Stock_Qty,Order_Multiple,Valid_To,Price_Date'];
  for (let i = 1; i <= BENCHMARK_ROWS; i++) {
    lines.push(`NM-PERF-${String(i).padStart(7,'0')},Clevite,${(100+i%999)/100},${i%2?'TR':'DE'},87088099,Passenger,${i%7},3,2027-10-23,2026-10-23`);
  }
  return Buffer.from(lines.join('\n')+'\n');
}

export async function admitBenchmark(batchSize, env = process.env, fetchImpl = fetch) {
  const url = 'https://kaxsqafdevabkxofwdod.supabase.co';
  if (env.SUPABASE_URL !== url || env.NM_PRODUCTION_TARGET || env.SUPPLIER_PRICE_TARGET_ENVIRONMENT === 'production'
    || ![250,500,1000].includes(batchSize) || String(batchSize) !== env.SUPPLIER_PRICE_SHADOW_BATCH_SIZE
    || env.SUPPLIER_PRICE_LOCAL_STREAM_ENABLED !== '1' || env.SUPPLIER_PRICE_COMMERCIAL_FIELDS_ENABLED !== '1'
    || env.SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED !== '1') throw Error('STAGING_BENCHMARK_TARGET_OR_CONFIG');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw Error('STAGING_BENCHMARK_CREDENTIAL_REQUIRED');
  const headers = {apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${key}`})};
  async function request(path, body, extra = {}) {
    const r = await fetchImpl(url+path,{method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'}),...extra},
      ...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(60000)});
    const raw = await r.text();
    const data = raw ? JSON.parse(raw) : null;
    // Only bounded domain error codes are safe in an operator receipt.
    if (!r.ok) throw Error(`STAGING_BENCHMARK_HTTP_${r.status}:${String(data?.message||data?.msg||'').match(/^[A-Z_]{5,80}$/)?.[0]||'REQUEST_FAILED'}`);
    return data;
  }
  const org='b0000000-0000-4000-8000-000000000001', actor='c945231b-af64-486d-8ac4-f733ec906bd2';
  const supplier=`b0231023-0000-4000-8000-${String(batchSize).padStart(12,'0')}`;
  const csv=benchmarkCsv(),sha=createHash('sha256').update(csv).digest('hex');
  const admitted = await request('/rest/v1/rpc/start_supplier_price_verified_upload_session',{
    input_organization_id:org,input_actor_id:actor,input_supplier_id:supplier,input_brand_id:'0e9fa984-fbbf-45d2-9a60-e7aa633dc928',
    input_file_name:'batch-comparison-50003.csv',input_content_type:'text/csv',input_total_bytes:csv.length,input_checksum_sha256:sha,
    input_idempotency_key:`perf-20261023-batch-${batchSize}`,input_mode:'replace',input_source_date:'2026-10-23'});
  const s=Array.isArray(admitted)?admitted[0]:admitted;
  console.log(JSON.stringify({stage:'admitted',batchSize,sessionId:s.session_id,releaseId:s.release_id,rows:BENCHMARK_ROWS,bytes:csv.length,sha256:sha,published:false}));
  await request(`/storage/v1/object/${s.storage_bucket}/${s.storage_object_path}`,csv,{'content-type':'text/csv','x-upsert':'false'});
  // Existing staging QA account, real Auth session, no email, password change or new grant.
  const link=await request('/auth/v1/admin/generate_link',{type:'magiclink',email:'staging-test-20261006@example.com'});
  const auth=await request('/auth/v1/verify',{type:'magiclink',token_hash:link.hashed_token});
  const claims=JSON.parse(Buffer.from(auth.access_token.split('.')[1],'base64url').toString());
  if(claims.sub!==actor||claims.iss!==url+'/auth/v1'||!claims.session_id) throw Error('STAGING_BENCHMARK_AUTH_IDENTITY');
  const receipt=await request('/rest/v1/rpc/request_supplier_price_upload_verification',{
    input_session_id:s.session_id,input_actor_id:actor,input_organization_id:org,input_auth_session_id:claims.session_id,
    input_token_iat:claims.iat,input_token_exp:claims.exp});
  if(receipt.release_id!==s.release_id||receipt.published!==false)throw Error('STAGING_BENCHMARK_ACCEPTANCE');
  return {stage:'queued',batchSize,releaseId:s.release_id,sessionId:s.session_id,rows:BENCHMARK_ROWS,sha256:sha,published:false};
}

if(process.argv[1]?.endsWith('/staging-batch-benchmark.mjs')) {
  admitBenchmark(Number(process.argv[2])).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
