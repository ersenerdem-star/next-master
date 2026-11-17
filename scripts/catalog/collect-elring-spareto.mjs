#!/usr/bin/env node
import fs from 'node:fs/promises';import path from 'node:path';import {gunzipSync,gzipSync} from 'node:zlib';import {setTimeout as sleep} from 'node:timers/promises';
import {codeKey,sha,decode,parseElringSpareto,sameProductRedirect} from './lib/elring-spareto.mjs';
const root='/Users/ersen/Developer/next-master/artifacts/elring',dir=path.join(root,'spareto-completion-2026-10-20');
await fs.mkdir(path.join(dir,'html'),{recursive:true});await fs.mkdir(path.join(dir,'evidence'),{recursive:true});await fs.mkdir(path.join(dir,'sitemaps'),{recursive:true});
const lockFile=path.join(dir,'collector.lock');try{const p=JSON.parse(await fs.readFile(lockFile,'utf8'));try{process.kill(p.pid,0);throw Error('COLLECTOR_ALREADY_RUNNING');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.unlink(lockFile);}catch(e){if(e.code!=='ENOENT')throw e;}
await fs.writeFile(lockFile,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
let status={status:'discovering',pid:process.pid,requests:0,processed:0,started_at:new Date().toISOString()};try{status={...JSON.parse(await fs.readFile(path.join(dir,'collection-status.json'),'utf8')),status:'discovering',pid:process.pid};}catch(e){if(e.code!=='ENOENT')throw e;}
const save=async()=>{status.updated_at=new Date().toISOString();await fs.writeFile(path.join(dir,'collection-status.json.tmp'),JSON.stringify(status,null,2));await fs.rename(path.join(dir,'collection-status.json.tmp'),path.join(dir,'collection-status.json'));};
let last=Date.now();async function get(url){const u=new URL(url);if(u.origin!=='https://spareto.com')throw Error('SOURCE_HOST');
 for(let attempt=0;attempt<3;attempt++){
  try{let current=url;const redirects=[];for(let hop=0;hop<4;hop++){
   await sleep(Math.max(0,1000-(Date.now()-last)));last=Date.now();status.requests++;await save();
   const r=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'user-agent':'NextMaster authorized Elring secondary completion/1.0'}});
   if([301,302,303,307,308].includes(r.status)){const target=sameProductRedirect(current,r.headers.get('location')||'');if(target===current)throw Error('SOURCE_REDIRECT_LOOP');redirects.push({from:current,to:target,status:r.status});current=target;continue;}
   if(r.status===404)return null;if(!r.ok){const e=new Error('SOURCE_HTTP_'+r.status);e.retry=[429,500,502,503,504].includes(r.status);throw e;}
   const b=Buffer.from(await r.arrayBuffer());if(b.length>16*1024*1024)throw Error('SOURCE_SIZE');b.source_url=current;b.redirect_chain=redirects;return b;
  }throw Error('SOURCE_REDIRECT_LIMIT');}
  catch(e){if(attempt===2||(!e.retry&&!['TypeError','TimeoutError'].includes(e.name)))throw e;await sleep((attempt+1)*3000);}
 }}
try{
 const official=JSON.parse(await fs.readFile(path.join(root,'complete-fitment-2026-10-20/stage-index.json'),'utf8'));const byCode=new Map(official.map(p=>[codeKey(p.product_code),p]));
 let manifest;try{manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;
  const robots=(await get('https://spareto.com/robots.txt')).toString();await fs.writeFile(path.join(dir,'robots.txt'),robots);
  const index='https://spareto.com/sitemaps/spareto.com/products/sitemap.xml.gz';if(!robots.includes(index))throw Error('SITEMAP_NOT_ADVERTISED');
  const maps=[...gunzipSync(await get(index)).toString().matchAll(/<loc>(https:\/\/spareto.com\/sitemaps\/spareto.com\/products\/sitemap\d+.xml.gz)<\/loc>/g)].map(m=>m[1]);if(!maps.length)throw Error('SITEMAP_EMPTY');
  const found=new Map();let outside=0;
  for(const [i,url] of maps.entries()){status.sitemap=i+1;status.sitemaps=maps.length;await save();const file=path.join(dir,'sitemaps',String(i)+'.xml.gz');let b;try{b=await fs.readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;b=await get(url);await fs.writeFile(file,b);}
   for(const m of gunzipSync(b).toString().matchAll(/<loc>(https:\/\/spareto.com\/products\/elring-[^<]+)<\/loc>/g)){const url=decode(m[1]),key=codeKey(new URL(url).pathname.split('/').at(-1)),p=byCode.get(key);if(!p){outside++;continue;}const previous=found.get(key);if(previous&&previous.source_url!==url)throw Error('AMBIGUOUS_SPARETO_PRODUCT_URL');found.set(key,{...p,source_url:url});}
   status.discovered=found.size;await save();
  }
  manifest={schema_version:'elring-spareto-manifest.v1',authorization_reference:'user-elring-spareto-missing-fields-2026-10-20',official_run:'cc0695cd-eb9f-43ef-9a3e-1371834fdb7f',sitemaps:maps.length,source_outside_official_scope:outside,products:[...found.values()].sort((a,b)=>a.row_index-b.row_index)};
  manifest.fingerprint=sha(JSON.stringify(manifest));await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
 }
 status.status='collecting';delete status.error;status.total=manifest.products.length;status.processed=0;status.source_missing=0;status.source_rejected=0;status.field_candidates={};await save();
 const counted=new Set();const count=(p,evidence)=>{if(counted.has(p.row_index))return;counted.add(p.row_index);status.processed++;
  if(evidence.status==='source_404')status.source_missing++;if(evidence.status==='source_rejected')status.source_rejected++;
  for(const f of Object.keys(evidence.fields||{}))status.field_candidates[f]=(status.field_candidates[f]||0)+1;
 };
 // Resumption reports total durable evidence, not just this process's sweep.
 for(const p of manifest.products){try{count(p,JSON.parse(await fs.readFile(path.join(dir,'evidence',p.row_index+'.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}
 await save();
 const primary=JSON.parse(await fs.readFile(path.join(root,'full-catalog-2026-10-19/products.json'),'utf8')).products;
 const noPhoto=new Set(primary.filter(p=>!p.image_url).map(p=>p.product_code));
 const ordered=[...manifest.products].sort((a,b)=>Number(noPhoto.has(b.product_code))-Number(noPhoto.has(a.product_code))||a.row_index-b.row_index);
 status.priority='official_image_missing_first';await save();
 for(const p of ordered){status.current_product=p.product_code;const file=path.join(dir,'evidence',p.row_index+'.json');let evidence;
  try{evidence=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;const b=await get(p.source_url);if(!b)evidence={product_code:p.product_code,source_url:p.source_url,status:'source_404'};
   else{const html=b.toString();try{evidence=parseElringSpareto(html,b.source_url||p.source_url,p.product_code);if(b.redirect_chain?.length){evidence.sitemap_url=p.source_url;evidence.redirect_chain=b.redirect_chain;}}catch(e){
    if(!['SPARETO_EXACT_IDENTITY','SPARETO_AMBIGUOUS_PROPERTY'].includes(e.message))throw e;
    evidence={product_code:p.product_code,source_url:p.source_url,status:'source_rejected',reason:e.message,html_sha256:sha(html),fields:{}};
   }evidence.stage_fingerprint=p.source_fingerprint;await fs.writeFile(path.join(dir,'html',p.row_index+'.html.gz'),gzipSync(b));}
   evidence.stage_fingerprint=p.source_fingerprint;
   await fs.writeFile(file+'.tmp',JSON.stringify(evidence));await fs.rename(file+'.tmp',file);
  }
  const previous=status.processed;count(p,evidence);await save();
  if(previous!==status.processed&&status.processed%100===0)console.log(JSON.stringify(status));
 }
 status.status=status.source_rejected?'completed_with_review':'completed';status.finished_at=new Date().toISOString();await save();
}catch(e){status.status='stopped';status.error=e.message;await save();console.error(e.stack);process.exitCode=1;}finally{await fs.unlink(lockFile);}
