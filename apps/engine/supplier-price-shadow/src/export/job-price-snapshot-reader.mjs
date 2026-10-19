// C3 LOCAL integration gate only. No import-time launch, provisioning or API.
// Reuses existing pricing RPCs; application Auth/context bridge is injected.
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {exportSpec,exportBinding,customerSafeExportRow} from './partitioned-price-export.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableStringify=value=>{
  if(value===null||typeof value!=='object') return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};
const stableDigest=value=>createHash('sha256').update(stableStringify(value)).digest('hex');
const normalizeVersionTimestamp=value=>{
  const raw=String(value??'').trim();
  const parsed=Date.parse(raw);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():raw;
};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=code=>{throw Error(`EXPORT_SNAPSHOT_${code}`);};
const cursor=n=>String(n).padStart(12,'0');
export function createJobPriceSnapshotReader({pool,mode,operationsAllowed,resolvePortalContext,pageSize=1000,checkpoint=()=>{},shouldYieldSnapshot=()=>false,assertWriteLease=()=>{},onPageTiming=()=>{}}){
  const url=new URL(pool?.options?.connectionString??'invalid:');
  const localTarget=mode==='local-only'&&url.protocol==='postgresql:'&&url.hostname==='127.0.0.1'
    &&/^\/nm_export_reader_[a-f0-9]{32}$/.test(url.pathname)&&Boolean(url.port)&&!url.search&&!url.hash;
  const hostedV3Target=mode==='hosted-v3'&&url.protocol==='postgresql:'
    &&(url.hostname==='aws-0-eu-west-1.pooler.supabase.com'||url.hostname==='db.kaxsqafdevabkxofwdod.supabase.co')
    &&(url.port==='6543'||url.port==='5432')&&url.pathname==='/postgres'&&!url.hash;
  if(!localTarget&&!hostedV3Target)fail(mode==='hosted-v3'?'V3_HOSTED_TARGET_REQUIRED':'LOCAL_TARGET_REQUIRED');
  if(typeof operationsAllowed!=='function'||typeof resolvePortalContext!=='function'||typeof checkpoint!=='function'
    ||typeof shouldYieldSnapshot!=='function'||typeof assertWriteLease!=='function'||typeof onPageTiming!=='function'
    ||!Number.isInteger(pageSize)||pageSize<1||pageSize>5000
    ||!Number.isInteger(pool.options.max)||pool.options.max<2||pool.options.max>5)fail('CONFIG_INVALID');
  async function authority(client,jobId){
    if(!uuid.test(jobId))fail('JOB_ID_INVALID');
    const {rows}=await client.query('select id,organization_id,requested_by,audience,export_type,status,scope,data_version,progress_total,created_at::text,expires_at>clock_timestamp() as unexpired from public.app_export_jobs where id=$1',[jobId]);
    const job=rows[0],s=job?.scope;
    if(!job||!['queued','running'].includes(job.status)||!job.unexpired||!s||!uuid.test(s.brandId))fail('JOB_DENIED');
    const brand=(await client.query('select id,name from public.brands where id=$1 and organization_id=$2',[s.brandId,job.organization_id])).rows[0];
    if(!brand||brand.name!==s.brandName)fail('BRAND_DENIED');
    let actor,context,requesterId,customerId=null,margin,currency;
    if(job.audience==='admin'&&job.export_type==='admin_price_list'){
      actor=(await client.query('select id,organization_id,role,department,permissions,is_active,session_revoked_at::text from public.profiles where id=$1 and organization_id=$2',[job.requested_by,job.organization_id])).rows[0];
      if(!actor||!actor.is_active||!operationsAllowed(actor.role,actor.department,actor.permissions)
        ||actor.session_revoked_at&&Date.parse(actor.session_revoked_at)>=Date.parse(job.created_at))fail('ACTOR_DENIED');
      if(!['A','B'].includes(s.priceListType)||typeof s.marginPercent!=='number'||!Number.isFinite(s.marginPercent))fail('PRICING_INVALID');
      requesterId=actor.id;margin=s.marginPercent;currency=s.currency??'EUR';
      context={priceListType:s.priceListType,margin,currency,unit:'decimal'};
    }else if(job.audience==='portal'&&job.export_type==='portal_price_list'){
      if(!uuid.test(s.inviteId)||!uuid.test(s.customerId))fail('INVITE_DENIED');
      actor=(await client.query('select id,organization_id,customer_id,party_type,status,access_can_view_orders,allowed_brand_ids,seller_company_profile_id,updated_at::text,expires_at is null or expires_at>clock_timestamp() as unexpired from public.portal_invites where id=$1 and organization_id=$2',[s.inviteId,job.organization_id])).rows[0];
      // Portal access normalizes NULL brand scopes to []; both mean all brands.
      const allowedBrandIds=Array.isArray(actor?.allowed_brand_ids)?actor.allowed_brand_ids:[];
      if(!actor||!['active','invited'].includes(actor.status)||!actor.unexpired||actor.party_type!=='customer'
        ||actor.customer_id!==s.customerId||!actor.access_can_view_orders
        ||allowedBrandIds.length&&!allowedBrandIds.includes(brand.id))fail('INVITE_DENIED');
      const customer=(await client.query("select id,organization_id,seller_company_profile_id,to_jsonb(c)->'seller_company_profile_ids' as seller_company_profile_ids,updated_at::text,custom_fields,price_list_type,price_list_margin_percent,currency from public.customers c where id=$1 and organization_id=$2",[s.customerId,job.organization_id])).rows[0];
      if(!customer)fail('CUSTOMER_DENIED');
      // Must be the existing server-owned context resolver, never browser fields.
      const p=await resolvePortalContext({client,invite:actor,brandId:brand.id,brandName:brand.name,customer});
      if(p?.organizationId!==job.organization_id||p.inviteId!==actor.id||p.customerId!==customer.id||p.brandId!==brand.id||p.brandName!==brand.name)fail('CONTEXT_SCOPE');
      if(!['A','B','Other'].includes(p.priceListType))fail('PRICING_TYPE_UNSUPPORTED');
      margin=p.priceListType==='B'?p.effectiveMarginB:p.effectiveMarginA;currency=p.currency;
      if(currency!=='EUR')fail('CURRENCY_UNSUPPORTED');
      if(typeof margin!=='number'||!Number.isFinite(margin)||s.priceListType!==p.priceListType||s.marginPercent!==margin||s.currency!==currency)fail('PRICING_CHANGED');
      requesterId=actor.id;customerId=customer.id;
      context={priceListType:p.priceListType,margin,currency,unit:'percent',customerUpdatedAt:customer.updated_at,
        effectiveMarginA:p.effectiveMarginA,effectiveMarginB:p.effectiveMarginB,
        cPriceListIds:p.cPriceListIds,inviteUpdatedAt:actor.updated_at};
    }else fail('AUDIENCE_DENIED');
    if(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))fail('CURRENCY_INVALID');
    const identity={jobId:job.id,organizationId:job.organization_id,requestedBy:job.requested_by,audience:job.audience,
      exportType:job.export_type,scope:s,dataVersion:job.data_version,createdAt:job.created_at,actor,context};
    return {job,brand,context,requesterId,customerId,authorityDigest:digest(identity)};
  }
  async function assertAuthorized(jobId){const c=await pool.connect();try{return await authority(c,jobId);}finally{c.release();}}
  async function withShortTransaction(callback){
    const client=await pool.connect();let begun=false;
    try{
      await client.query('begin isolation level repeatable read');begun=true;
      // The first page also computes exact eligibility across the full source.
      // Keep this bounded below the 120s job lease; continuations checkpoint
      // committed pages before the background invocation budget expires.
      await client.query("set local statement_timeout='90s'; set local lock_timeout='5s'; set local idle_in_transaction_session_timeout='120s'");
      const value=await callback(client);
      await client.query('commit');begun=false;
      return value;
    }catch(error){if(begun)await client.query('rollback').catch(()=>{});throw error;}
      finally{client.release();}
  }
  async function assertSourceVersion(client,authorityState){
    const {rows}=await client.query('select public.get_admin_price_list_export_version($1,$2) as version',[authorityState.job.organization_id,authorityState.brand.id]);
    const baseDataVersion=String(rows[0]?.version||'');
    const expectedDataVersion=authorityState.job.audience==='portal'&&authorityState.job.export_type==='portal_price_list'
      ? stableDigest({
          baseDataVersion,
          customerId:authorityState.customerId,
          priceListType:authorityState.context.priceListType,
          effectiveMarginA:authorityState.context.effectiveMarginA,
          effectiveMarginB:authorityState.context.effectiveMarginB,
          cPriceListIds:authorityState.context.cPriceListIds,
          inviteUpdatedAt:normalizeVersionTimestamp(authorityState.context.inviteUpdatedAt||''),
        })
      : baseDataVersion;
    if(expectedDataVersion!==String(authorityState.job.data_version||''))fail('SOURCE_CHANGED');
  }
  async function resolveAuthorizedInput(jobId){
    if(!uuid.test(jobId))fail('JOB_ID_INVALID');
    const a=await assertAuthorized(jobId);
    await withShortTransaction(client=>assertSourceVersion(client,a));
    const existing=await withShortTransaction(client=>client.query("select id,descriptor,authority_digest,status from export_snapshot_private.snapshots where job_id=$1",[jobId]).then(result=>result.rows[0]));
    if(existing){
      if(existing.authority_digest!==a.authorityDigest)fail('AUTHORITY_CHANGED');
      if(existing.status==='sealed'){
        const current=await assertAuthorized(jobId);if(current.authorityDigest!==a.authorityDigest)fail('AUTHORITY_CHANGED');
        await withShortTransaction(client=>assertSourceVersion(client,current));
        const {schema,...spec}=exportSpec(existing.descriptor);return spec;
      }
      if(existing.status!=='building')fail('AUTHORITY_CHANGED');
    }
    const id=existing?.id??randomUUID();
    if(!existing) await withShortTransaction(async client=>{
      await assertWriteLease(client,jobId);
      return client.query("insert into export_snapshot_private.snapshots(id,job_id,status,authority_digest) values($1,$2,'building',$3)",[id,jobId,a.authorityDigest]);
    });
    const fn=a.job.audience==='admin'?'cloud_admin_price_list_page_fast':'cloud_portal_customer_price_list_page_fast';
    const existingProgress=existing?await withShortTransaction(client=>client.query(`
      select
        (select count(*)::bigint from export_snapshot_private.rows where snapshot_id=$1) as count,
        (select max(ordinal)::bigint from export_snapshot_private.rows where snapshot_id=$1) as last_ordinal,
        (select source_key from export_snapshot_private.rows where snapshot_id=$1 order by ordinal desc limit 1) as last_source_key
    `,[id]).then(result=>result.rows[0])):null;
    let after=existingProgress?.last_source_key??null,processed=Number(existingProgress?.count??0),total=Number(a.job.progress_total??0)||null,spec;
    if(existingProgress&&(processed!==Number(existingProgress.last_ordinal??0)||processed>0&&!after))fail('READ_COVERAGE');
    const makeSpec=expectedRows=>{
      const candidate={tenantId:a.job.organization_id,requesterId:a.requesterId,audience:a.job.audience==='portal'?'customer':'admin',
        customerId:a.customerId,snapshotId:id,pricingVersion:digest({context:a.context,dataVersion:a.job.data_version}),
        brand:a.brand.name,currency:a.context.currency,expectedRows,pageSize};
      const {schema,...normalized}=exportSpec(candidate);return normalized;
    };
    if(total!=null) spec=makeSpec(total);
    if(processed>0&&total==null){
      const header=await withShortTransaction(client=>client.query(`select total_count::text from public.${fn}($1,$2,$3,$4,null,null,$5) limit 1`,[a.job.organization_id,a.brand.id,a.context.priceListType==='Other'?'A':a.context.priceListType,a.context.margin,pageSize]).then(result=>result.rows[0]));
      total=Number(header?.total_count??0)||null;if(total!=null) spec=makeSpec(total);
    }
    while(total==null||processed<total){
      const pageStarted=performance.now();
      const transactionStarted=performance.now();
      const pageResult=await withShortTransaction(async client=>{
        const timing={pricingRpcMs:0,replacementLookupMs:0,snapshotInsertMs:0};
        // Resolve account pricing and permissions in the same repeatable-read
        // transaction as the rows being captured for this page.  The source
        // version is fenced at invocation start and again before sealing (and
        // at the start of every continuation).  Recomputing the full legacy
        // fingerprint on every 5,000-row page made a large export pay the
        // same O(N) scan ten or more times without improving publication
        // safety: a changed source is rejected by the final fence.
        const live=await authority(client,jobId);if(live.authorityDigest!==a.authorityDigest)fail('AUTHORITY_CHANGED');
        await assertWriteLease(client,jobId);
        const pricingStarted=performance.now();
        const page=(await client.query(`select normalized_code,product_code,brand,description,sales_price::text,price_date::text,lifecycle_status,total_count::text
          from public.${fn}($1,$2,$3,$4,null,$5,$6)`,[a.job.organization_id,a.brand.id,a.context.priceListType==='Other'?'A':a.context.priceListType,a.context.margin,after,pageSize])).rows;
        timing.pricingRpcMs=performance.now()-pricingStarted;
        if(!page.length)fail('SOURCE_EMPTY');
        if(page.length>pageSize)fail('SOURCE_COVERAGE');
        // The optimized RPC emits total_count only on the first keyset page.
        // Continuation pages intentionally return NULL, so retain the frozen
        // total discovered earlier instead of treating NULL as zero.
        const rawReportedCount = page[0].total_count == null ? null : Number(page[0].total_count);
        // The current count-once SQL returns aggregate zero on continuation
        // pages (the filtered count CTE has no joined row), while older
        // versions returned NULL. Both mean "not reported" once total is
        // already frozen; a non-empty first page may never report zero.
        const reportedCount = total != null && rawReportedCount === 0 ? null : rawReportedCount;
        const expectedTotal=total==null?reportedCount:total;
        let nextSpec=spec;
        if(total==null){
          if(!Number.isSafeInteger(reportedCount)||reportedCount<1)fail('SOURCE_COVERAGE');
          nextSpec=makeSpec(reportedCount);
        }
        const reportedTotals=page.map(r=>r.total_count).filter(value=>value!=null).map(Number)
          .filter(value=>!(total!=null&&value===0));
        if(reportedTotals.length===0&&total==null)fail('SOURCE_COVERAGE');
        if(reportedTotals.some(value=>value!==expectedTotal)||(reportedCount!=null&&reportedCount!==expectedTotal)||processed+page.length>expectedTotal)fail('SOURCE_COVERAGE');
        const keys=page.map(r=>r.normalized_code);
        if(new Set(keys).size!==keys.length)fail('SOURCE_CURSOR');
        const replacementStarted=performance.now();
        const replacementRows=(await client.query(`select public.normalize_catalog_product_code(ref.old_code) as exact_old_code,ref.new_code
          from public.item_code_references ref
          join unnest($3::text[]) as requested(code)
            on ref.normalized_old_code=public.normalize_part_code(requested.code)
           and public.normalize_catalog_product_code(ref.old_code)=requested.code
          where ref.organization_id=$1 and ref.brand_id=$2 and ref.is_active=true`,[a.job.organization_id,a.brand.id,keys])).rows;
        timing.replacementLookupMs=performance.now()-replacementStarted;
        const replacements=new Map(replacementRows.map(r=>[r.exact_old_code,r.new_code]));
        if(replacements.size!==replacementRows.length)fail('REPLACEMENT_CONFLICT');
        const records=[];let nextAfter=after,nextProcessed=processed;
        for(const row of page){
          if(typeof row.normalized_code!=='string'||!row.normalized_code.trim()||row.normalized_code===nextAfter)fail('SOURCE_CURSOR');
          nextProcessed++;
          const safe=customerSafeExportRow({code:row.product_code,cursorKey:cursor(nextProcessed),brand:row.brand,description:row.description,
            price:row.sales_price,currency:nextSpec.currency,priceDate:row.price_date,discontinued:row.lifecycle_status==='discontinued',
            replacementCode:replacements.get(row.normalized_code)??''},exportSpec(nextSpec));
          records.push({ordinal:nextProcessed,source_key:row.normalized_code,payload:safe});nextAfter=row.normalized_code;
        }
        if(Buffer.byteLength(JSON.stringify(records))>8*1024*1024)fail('PAGE_BYTE_BUDGET');
        const insertStarted=performance.now();
        await client.query(`insert into export_snapshot_private.rows(snapshot_id,ordinal,source_key,payload)
          select $1,x.ordinal,x.source_key,x.payload from jsonb_to_recordset($2::jsonb) x(ordinal bigint,source_key text,payload jsonb)`,[id,JSON.stringify(records)]);
        timing.snapshotInsertMs=performance.now()-insertStarted;
        return {nextAfter,nextProcessed,expectedTotal,nextSpec,pageRows:page.length,timing};
      });
      const transactionMs=performance.now()-transactionStarted;
      after=pageResult.nextAfter;processed=pageResult.nextProcessed;total=pageResult.expectedTotal;spec=pageResult.nextSpec;
      const checkpointStarted=performance.now();
      let checkpointOk=false;
      try{
        await checkpoint({jobId,processed,total});
        checkpointOk=true;
      }finally{
        // Telemetry cannot change the export result, including when a progress
        // update fails. Emit only timing/count metadata, never priced rows.
        try{onPageTiming({jobId,processed,total,pageRows:pageResult.pageRows,...pageResult.timing,
          transactionMs,checkpointMs:performance.now()-checkpointStarted,pageMs:performance.now()-pageStarted,checkpointOk});}
        catch{/* diagnostic observer failure must not fail a committed page */}
      }
      // Every committed page is a resumable checkpoint. Yield only after the
      // progress/lease update succeeds, and seal here if this was the last page.
      if(processed<total&&await shouldYieldSnapshot({jobId,snapshotId:id,processed,total})){
        return Object.freeze({status:'building',snapshotId:id,processed,total});
      }
    }
    await withShortTransaction(async client=>{
      const current=await authority(client,jobId);if(current.authorityDigest!==a.authorityDigest)fail('AUTHORITY_CHANGED');
      await assertWriteLease(client,jobId);
      await assertSourceVersion(client,current);
      const sealed=await client.query("update export_snapshot_private.snapshots set status='sealed',descriptor=$2::jsonb,binding=$3 where id=$1 and status='building' and authority_digest=$4 returning id",[id,JSON.stringify(spec),exportBinding(spec),a.authorityDigest]);
      if(sealed.rowCount!==1)fail('AUTHORITY_CHANGED');
    });
    return Object.freeze(spec);
  }
  async function fetchPage({spec,binding,after,limit}){
    const {schema,...input}=exportSpec(Object.fromEntries(Object.entries(spec).filter(([k])=>k!=='schema')));
    if(binding!==exportBinding(input)||!uuid.test(input.snapshotId)||!Number.isInteger(limit)||limit<1||limit>input.pageSize
      ||after!=null&&!/^\d{12}$/.test(after))fail('READ_SCOPE');
    const client=await pool.connect();
    try{
      const frozen=(await client.query("select job_id,status,authority_digest,descriptor,binding from export_snapshot_private.snapshots where id=$1",[input.snapshotId])).rows[0];
      if(!frozen||frozen.status!=='sealed'||frozen.binding!==binding||exportBinding(frozen.descriptor)!==binding)fail('READ_SCOPE');
      const current=await authority(client,frozen.job_id);if(current.authorityDigest!==frozen.authority_digest)fail('AUTHORITY_CHANGED');
      const offset=after==null?0:Number(after);
      // Keep the selected cursor string for the payload contract, but order by
      // the underlying numeric ordinal. `order by ordinal` would resolve to
      // the selected text alias and produce lexical order (1, 10, 100, ...),
      // which violates contiguous snapshot coverage for 1K+ exports.
      const page=(await client.query('select ordinal::text,payload from export_snapshot_private.rows where snapshot_id=$1 and ordinal>$2 order by ordinal::bigint limit $3',[input.snapshotId,offset,limit])).rows;
      if(!page.length||page.some((r,i)=>Number(r.ordinal)!==offset+i+1)||page.some(r=>r.payload.cursorKey!==cursor(Number(r.ordinal))))fail('READ_COVERAGE');
      const end=Number(page.at(-1).ordinal),done=end===input.expectedRows;
      return {binding,expectedRows:input.expectedRows,rows:page.map(r=>r.payload),done,nextCursor:done?null:cursor(end)};
    }finally{client.release();}
  }
  return Object.freeze({resolveAuthorizedInput,fetchPage,assertAuthorized});
}
