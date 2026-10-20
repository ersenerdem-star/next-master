#!/usr/bin/env node
// Bounded full-brand collection. The exact-product engine remains unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {resolveSyncEnvValue} from '../shared/load-sync-env.mjs';
import {ELRING, FIELDS, codeKey, fingerprint, assertSource, mapElringArticle} from './lib/elring-official-provider.mjs';
import {stageRows} from '../../netlify/functions/_shared/catalog/elring-provider-package.mjs';

const ORG='1e4c5e99-e387-41aa-a6d3-cbe74558f766';
const BRAND='1412aa4b-5518-427c-9de1-264758bb6811';
const PAGE=250;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export function validatePage(result,{prefix='',page=1,expectedTotal=null}={}) {
  if(result.status!==200 || !Number.isInteger(result.totalMatchingArticles) || result.totalMatchingArticles<0
    || result.totalMatchingArticles>30000 || !Array.isArray(result.articles) || result.articles.length>PAGE)
    throw Error('INVALID_BRAND_PAGE');
  if(expectedTotal!=null && result.totalMatchingArticles!==expectedTotal)throw Error('SOURCE_TOTAL_CHANGED');
  const pages=Math.ceil(result.totalMatchingArticles/PAGE);
  if(pages>result.maxAllowedPage)throw Error('SOURCE_RESULT_WINDOW_EXCEEDED');
  const expected=Math.min(PAGE,Math.max(0,result.totalMatchingArticles-(page-1)*PAGE));
  if(result.articles.length!==expected)throw Error('SOURCE_PAGE_CARDINALITY');
  const keys=new Set();
  for(const a of result.articles){
    if(a.dataSupplierId!==10 || a.mfrName!=='ELRING' || !codeKey(a.articleNumber)
      || !a.articleNumber.startsWith(prefix))throw Error('SOURCE_IDENTITY_OR_PREFIX_MISMATCH');
    const key=codeKey(a.articleNumber);if(keys.has(key))throw Error('SOURCE_DUPLICATE_IDENTITY');keys.add(key);
  }
  return pages;
}
export function validateCollection(articles,expected){
  if(articles.length!==expected || new Set(articles.map(a=>codeKey(a.articleNumber))).size!==expected)
    throw Error('FULL_BRAND_CARDINALITY_MISMATCH');
}
export function mapBaseArticle(article){
  try{return mapElringArticle(article);}catch(error){
    if(!error.message.startsWith('AMBIGUOUS_DIMENSION:'))throw error;
    // Some gasket sets carry different dimensions for their component parts.
    // Preserve the original evidence; one scalar dimension cannot represent it.
    const keep=c=>!/^(inner diameter|outer diameter|diameter|length|width|height|thickness)(?:\s|$)/i.test(c.criteriaDescription||c.criteriaAbbrDescription||'');
    const o=mapElringArticle({...article,articleCriteria:(article.articleCriteria||[]).filter(keep),articleLogisticsCriteria:(article.articleLogisticsCriteria||[]).filter(keep)});
    o.raw=article;o.fields.dimensions=null;o.field_status.dimensions='conflict';o.limitations.push('source_component_dimensions_require_review');return o;
  }
}

export async function main(argv=process.argv.slice(2)){
  const args={};for(let i=0;i<argv.length;i++){const key=argv[i].replace(/^--/,'');args[key]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;}
  if(!args['confirm-production'])throw Error('CONFIRM_PRODUCTION_REQUIRED');
  const output=path.resolve(args.output||'artifacts/elring/full-catalog-2026-10-19');
  await fs.mkdir(output,{recursive:true});
  let report;try{report=JSON.parse(await fs.readFile(path.join(output,'status.json'),'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw e;report={version:'elring-brand.v1',started_at:new Date().toISOString(),status:'collecting',requests:0,staged_pages:0,enriched_offset:0,lifecycle_offset:0};}
  if(report.version!=='elring-brand.v1')throw Error('REPORT_VERSION_MISMATCH');
  const save=async()=>{report.updated_at=new Date().toISOString();await fs.writeFile(path.join(output,'status.json.tmp'),JSON.stringify(report,null,2));await fs.rename(path.join(output,'status.json.tmp'),path.join(output,'status.json'));};
  const db=createClient(resolveSyncEnvValue('SUPABASE_URL',{projectRoot:process.cwd()}),resolveSyncEnvValue('SUPABASE_SERVICE_ROLE_KEY',{projectRoot:process.cwd()}),{
    auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(120000),redirect:'error'})}});
  const source=await db.from('catalog_external_sources').select('*').eq('organization_id',ORG).eq('source_key',ELRING.sourceKey).single();
  if(source.error)throw source.error;
  assertSource(source.data,{publish:!!args.publish,approvalActor:source.data.metadata.approval_actor,approvalReference:source.data.metadata.publication_approval_reference});
  if(source.data.metadata.brand_collection_allowed!==true)throw Error('BRAND_COLLECTION_NOT_AUTHORIZED');
  report.status='collecting';delete report.error;await save();
  const rpc=async(name,params)=>{const r=await db.rpc(name,params);if(r.error)throw Error(`${name}: ${r.error.message}`);return r.data;};
  let lastRequest=0;
  const collect=async(key,extra,{root=false}={})=>{
    const filename=path.join(output,`${key}.json`);
    try{return JSON.parse(await fs.readFile(filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(report.requests>=500)throw Error('SOURCE_REQUEST_LIMIT');
    await sleep(Math.max(0,1100-(Date.now()-lastRequest)));lastRequest=Date.now();report.requests++;await save();
    const request={getArticles:{articleCountry:'GB',provider:2122,lang:'en',dataSupplierIds:[10],page:1,perPage:PAGE,
      includeAll:false,includeGenericArticles:true,includeArticleCriteria:true,includeArticleLogisticsCriteria:true,
      includeImages:true,includeOEMNumbers:true,includeGTINs:true,includeArticleText:true,includeMisc:true,
      includeReplacesArticles:true,includeReplacedByArticles:true,includePrices:false,...extra}};
    const r=await fetch(ELRING.api,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/json',origin:'https://web.tecalliance.net',referer:ELRING.url},body:JSON.stringify(request)});
    if(!r.ok){await r.body?.cancel();throw Error(`ELRING_HTTP_${r.status}`);}
    const chunks=[];let bytes=0;for await(const chunk of r.body){bytes+=chunk.length;if(bytes>8*1024*1024)throw Error('SOURCE_RESPONSE_BYTE_LIMIT');chunks.push(chunk);}
    const response=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(root){if(response.status!==200 || !Number.isInteger(response.totalMatchingArticles) || response.totalMatchingArticles>30000)throw Error('INVALID_ROOT_TOTAL');}
    else validatePage(response,{prefix:extra.searchQuery,page:extra.page||1});
    const evidence={request,response,retrieved_at:new Date().toISOString(),response_fingerprint:fingerprint(response)};
    await fs.writeFile(filename+'.tmp',JSON.stringify(evidence));await fs.rename(filename+'.tmp',filename);return evidence;
  };
  try{
    const root=await collect('root',{}, {root:true});report.expected_total=root.response.totalMatchingArticles;await save();
    const articles=[],observations=[];
    // Search type 0 is article number. Type 10 also searches OEM/comparable
    // numbers and cannot partition a manufacturer's product identities.
    for(const prefix of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'){
      const first=await collect(`prefix-${prefix}-1`,{searchQuery:prefix,searchType:0,searchMatchType:'prefix',page:1});
      const pages=validatePage(first.response,{prefix});
      for(let page=1;page<=pages;page++){
        const evidence=page===1?first:await collect(`prefix-${prefix}-${page}`,{searchQuery:prefix,searchType:0,searchMatchType:'prefix',page});
        validatePage(evidence.response,{prefix,page,expectedTotal:first.response.totalMatchingArticles});
        for(const article of evidence.response.articles){
          articles.push(article);
          const o=mapBaseArticle(article);o.observed_at=evidence.retrieved_at;o.response_fingerprint=evidence.response_fingerprint;
          o.collection_profile='base_attributes';o.fitment=null;o.limitations.push('vehicle_fitment_pending');
          observations.push(o);
        }
      }
      report.collected=articles.length;await save();console.log(JSON.stringify({prefix,collected:articles.length,expected:report.expected_total}));
      // Once root cardinality is reached, no unseen manufacturer identities
      // remain. Final validation also rejects duplicate normalized identities.
      if(articles.length===report.expected_total)break;
    }
    validateCollection(articles,report.expected_total);
    const current=await collect('root-end',{}, {root:true});
    if(current.response.totalMatchingArticles!==report.expected_total)throw Error('SOURCE_TOTAL_CHANGED_DURING_COLLECTION');
    report.collection_verified=true;
    report.source_coverage=Object.fromEntries(FIELDS.map(f=>[f,observations.filter(o=>o.field_status[f]==='present').length]));
    report.fitment_status='pending';report.image_status='review_required';
    await fs.writeFile(path.join(output,'codes.json'),JSON.stringify(articles.map(a=>a.articleNumber)));
    await save();
    const rows=stageRows(observations),totalPages=Math.ceil(rows.length/PAGE);
    const run=await rpc('begin_or_resume_catalog_provider_stage',{input_organization_id:ORG,input_source_key:ELRING.sourceKey,
      input_collection_key:`elring-brand-${fingerprint(rows).slice(0,24)}`,input_brand:ELRING.brand,
      input_scope:{collector:'collect-elring-official-catalog.mjs',collection_profile:'base_attributes',fitment_status:'pending',source_total:rows.length,manifest_fingerprint:fingerprint(rows)}});
    if(report.run_id && report.run_id!==run.run_id)throw Error('RESUME_RUN_MISMATCH');report.run_id=run.run_id;await save();
    for(let page=report.staged_pages;page<totalPages;page++){
      const params={input_run_id:run.run_id,input_page_number:page,input_page_size:PAGE,input_total_elements:rows.length,input_total_pages:totalPages,payload:rows.slice(page*PAGE,(page+1)*PAGE)};
      await rpc('stage_catalog_provider_identity_page',{...params,input_source_url:ELRING.url,input_retrieved_at:root.retrieved_at});
      await rpc('verify_catalog_provider_stage_page',params);report.staged_pages=page+1;await save();
      if(page%10===0)console.log(JSON.stringify({staged_pages:page+1,totalPages,run_id:run.run_id}));
    }
    await rpc('seal_catalog_provider_stage_strict',{input_run_id:run.run_id});report.status='staged';await save();
    if(!args.publish)return;
    // Base publication admits only observed scalar attributes; absent segment,
    // vehicles and models remain null. Full-fitment package rules are unchanged.
    for(let n=0;n<300;n++){
      const p=await rpc('publish_catalog_provider_stage_batch',{input_run_id:run.run_id,input_brand_id:BRAND,input_expected_rows:rows.length,
        input_approval_actor:source.data.metadata.approval_actor,input_approval_reference:source.data.metadata.publication_approval_reference,input_batch_size:250});
      if(report.publication && p.status!=='completed' && p.processed_rows<=report.publication.processed_rows)throw Error('PUBLICATION_NO_PROGRESS');
      report.publication=p;await save();console.log(JSON.stringify({publication:p}));if(p.status==='completed')break;
    }
    if(report.publication?.status!=='completed')throw Error('PUBLICATION_BATCH_LIMIT');
    for(let offset=report.enriched_offset;offset<rows.length;offset+=25){
      const r=await rpc('enrich_elring_provider_stage_batch',{input_run_id:run.run_id,input_brand_id:BRAND,input_offset:offset,input_batch_size:25});
      if(r.processed!==Math.min(25,rows.length-offset))throw Error('ENRICHMENT_CARDINALITY');
      report.enriched_offset=offset+r.processed;await save();
      if(offset%500===0)console.log(JSON.stringify({enriched:report.enriched_offset,total:rows.length}));
    }
    for(let offset=report.lifecycle_offset;offset<rows.length;offset+=25){
      const r=await rpc('apply_elring_provider_lifecycle_batch',{input_run_id:run.run_id,input_brand_id:BRAND,input_offset:offset,input_batch_size:25});
      if(r.processed!==Math.min(25,rows.length-offset))throw Error('LIFECYCLE_CARDINALITY');
      report.lifecycle_offset=offset+r.processed;report.lifecycle_totals ||= {};
      for(const key of ['discontinued_applied','relations_inserted','rejected_relations','lifecycle_conflicts','no_explicit_signal'])report.lifecycle_totals[key]=(report.lifecycle_totals[key]||0)+(r[key]||0);
      await save();if(offset%500===0)console.log(JSON.stringify({lifecycle:report.lifecycle_offset,total:rows.length}));
    }
    const canonical=[];
    for(let offset=0;offset<rows.length;offset+=250){
      const r=await db.from('catalog_products').select(`id,normalized_code,${FIELDS.join(',')}`).eq('organization_id',ORG).eq('brand_id',BRAND).in('normalized_code',rows.slice(offset,offset+250).map(r=>codeKey(r.product_code)));
      if(r.error)throw r.error;canonical.push(...r.data);
    }
    if(canonical.length!==rows.length || new Set(canonical.map(p=>p.normalized_code)).size!==rows.length)throw Error('CANONICAL_REREAD_CARDINALITY');
    report.canonical_coverage=Object.fromEntries(FIELDS.map(f=>[f,canonical.filter(p=>p[f]!=null && p[f]!=='' && (typeof p[f]!=='object'||Object.keys(p[f]).length)).length]));
    await fs.writeFile(path.join(output,'canonical-reread.json'),JSON.stringify(canonical));
    report.status='base_attributes_published_verified';report.finished_at=new Date().toISOString();delete report.error;await save();console.log(JSON.stringify(report));
  }catch(e){report.status='failed';report.error=String(e.message);await save();throw e;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
