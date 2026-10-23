import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeCatalogProgress,readCatalogProgress,progressSources} from '../../netlify/functions/_shared/catalog/operations-progress.mjs';
const base={id:'job1',brand:'Elring',mode:'stage',source:'official',status:'running',next_index:10,total_items:100,updated_at:'2026-10-23T20:00:00Z'};
test('Job processing progress is not reported as canonical product completeness',()=>{
 const [row]=summarizeCatalogProgress([{kind:'brand',rows:[base]}]);
 assert.equal(row.processed,10);assert.equal(row.total,100);assert.equal(row.changed,null);assert.equal(row.activeJobs,1);
 assert.equal('data_completeness_percent' in row,false);
});
test('Elring fitment shows actual processed/changed without inventing total scope',()=>{
 const [row]=summarizeCatalogProgress([{kind:'elring-completion',rows:[{run_id:'run',phase:'fitment',status:'running',processed:1929,changed:1606,updated_at:base.updated_at}]}]);
 assert.equal(row.brand,'Elring');assert.equal(row.processed,1929);assert.equal(row.changed,1606);assert.equal(row.total,null);
});
test('Active older work remains visible even when newer batches have completed',()=>{
 const [row]=summarizeCatalogProgress([{kind:'brand',rows:[{...base,status:'queued'}, {...base,id:'new',status:'completed',next_index:100,updated_at:'2026-10-23T20:01:00Z'}, {...base,id:'old',status:'queued',updated_at:'2026-10-23T19:00:00Z'}]}]);
 assert.equal(row.id,'job1');assert.equal(row.status,'queued');assert.equal(row.activeJobs,2);
});
test('Phase, source and brand identities stay separate',()=>{
 const rows=summarizeCatalogProgress([{kind:'brand',rows:[base,{...base,id:'other-source',source:'secondary'},{...base,id:'publish',mode:'publish'},{...base,id:'other-brand',brand:'Delphi'}]}]);
 assert.equal(rows.length,4);
});
test('Reads are tenant-scoped, bounded, read-only and omit manifests/codes',async()=>{
 const calls=[];const db={from(table){const chain={};for(const method of ['select','eq','in','not','order','limit'])chain[method]=(...args)=>{calls.push({table,method,args});return chain;};chain.then=(resolve)=>resolve({data:[],error:null});return chain;}};
 const result=await readCatalogProgress(db,'org');assert.deepEqual(result.rows,[]);assert.equal(result.truncated,false);
 for(const source of progressSources){assert.equal(calls.filter(c=>c.table===source.table&&c.method==='eq'&&c.args[0]==='organization_id'&&c.args[1]==='org').length,2);}
 assert.ok(calls.filter(c=>c.method==='limit').every(c=>[201,60].includes(c.args[0])));
 assert.ok(calls.filter(c=>c.method==='select').every(c=>!c.args[0].split(',').includes('manifest')));
});
test('Unavailable source fails visibly instead of pretending zero jobs',async()=>{
 const db={from(){const chain={};for(const method of ['select','eq','in','not','order','limit'])chain[method]=()=>chain;chain.then=(resolve)=>resolve({data:null,error:{message:'not allowed'}});return chain;}};
 await assert.rejects(readCatalogProgress(db,'org'),/CATALOG_PROGRESS_UNAVAILABLE/);
});
