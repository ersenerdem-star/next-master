import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import unzipper from 'unzipper';
import { SaxesParser } from 'saxes';
import { preparePriceExport,assemblePriceExport } from './partitioned-price-export.mjs';
import { fixtureSpec,fixtureSource } from './local-export-fixture.mjs';

if(!process.argv.includes('--local-only'))throw new Error('LOCAL_ONLY_REQUIRED');
const runId=randomUUID(),directory=resolve('artifacts/export-upgrade',runId);
await mkdir(directory,{recursive:true,mode:0o700});
const report={runId,mode:'local-partitioned-streaming-export-proof',remoteCalls:0,productionWrites:0,
  distributedDbosProof:false,authenticatedUiProof:false,results:[]};

// Independent ZIP/XML validation: no ExcelJS reader and no complete-sheet array.
async function verify(file,expectedRows) {
  const zip=await unzipper.Open.file(file),sheets=zip.files.filter(f=>/^xl\/worksheets\/sheet\d+\.xml$/.test(f.path));
  let total=0,formulaNodes=0;const rowCounts=[];
  for(const entry of sheets) {
    let cells={},column='',capturing=false,cellText='',type='',count=0;
    const parser=new SaxesParser();
    parser.on('opentag',tag=>{
      if(tag.name==='row')cells={};
      if(tag.name==='c'){column=String(tag.attributes.r).replace(/\d/g,'');type=tag.attributes.t || 'n';cellText='';}
      if(tag.name==='v'||tag.name==='t')capturing=true;
      if(tag.name==='f')formulaNodes++;
    });
    parser.on('text',value=>{if(capturing)cellText+=value;});
    parser.on('closetag',tag=>{
      if(tag.name==='v'||tag.name==='t')capturing=false;
      if(tag.name==='c')cells[column]={value:cellText,type};
      if(tag.name==='row') {
        if(count===0) {
          assert.deepEqual(['A','B','C','D','E'].map(c=>cells[c].value),['Part_No','Description','Price_EUR','Price_Date','Lifecycle']);
        } else {
          total++;assert.equal(cells.A.value,String(986479379+total).padStart(10,'0'));
          assert.notEqual(cells.A.type,'n');assert.equal(cells.C.type,'n');assert.equal(cells.C.value,'1.23456');
          assert.equal(cells.D.value,'2026-10-04');
          assert.equal(cells.B.value,total===1 ? '=1+1' : `Synthetic filter ${total} – Türkçe`);
          assert.equal(cells.E.value,total===2 ? 'Discontinued; replacement: 0000123456' : 'Active');
          assert.doesNotMatch(JSON.stringify(cells),/DO-NOT-EXPORT/);
        }
        count++;
      }
    });
    const decoder=new StringDecoder('utf8');
    for await(const chunk of entry.stream())parser.write(decoder.write(chunk));
    parser.write(decoder.end()).close();rowCounts.push(count-1);
  }
  assert.equal(total,expectedRows);assert.equal(formulaNodes,0);
  return {verifiedRows:total,formulaNodes,rowCounts,leadingZeros:true,allNumericPrices:true,privateDataAbsent:true};
}
async function run(count,audience) {
  const input=fixtureSpec(count,{audience,pageSize:5000}),dir=join(directory,`${audience}-${count}`);
  const started=performance.now();let peakRss=process.memoryUsage().rss,maxHeap=process.memoryUsage().heapUsed,ticks=0;
  const monitor=setInterval(()=>{ticks++;peakRss=Math.max(peakRss,process.memoryUsage().rss);maxHeap=Math.max(maxHeap,process.memoryUsage().heapUsed);},50);
  const progress=event=>{if(event.processedRows%100000===0 || event.stage==='ready')console.log(JSON.stringify({audience,...event}));};
  try {
    const prepared=await preparePriceExport({input,directory:dir,fetchPage:fixtureSource(input),progress});
    const partitionMs=Math.round(performance.now()-started),assemblyStart=performance.now();
    const receipt=await assemblePriceExport({input,directory:dir,progress}),assemblyMs=Math.round(performance.now()-assemblyStart);
    const repeat=await preparePriceExport({input,directory:dir,fetchPage:()=>{throw new Error('REPLAY_MUST_NOT_FETCH');}});
    const cached=await assemblePriceExport({input,directory:dir});assert.equal(cached.replayed,true);assert.equal(cached.sha256,receipt.sha256);
    const verifyStart=performance.now(),verified=await verify(join(dir,receipt.file),count);
    const result={audience,rows:count,partitions:prepared.manifest.parts.length,sourceCalls:prepared.fetched,
      reusedOnReplay:repeat.reused,sourceCallsOnReplay:repeat.fetched,receipt,verified,
      partitionMs,assemblyMs,verificationMs:Math.round(performance.now()-verifyStart),peakRssBytes:peakRss,maxHeapBytes:maxHeap,timerTicks:ticks};
    report.results.push(result);console.log(JSON.stringify({stage:'verified',audience,rows:count,assemblyMs,peakRssMB:Math.round(peakRss/1024/1024)}));
  } finally {clearInterval(monitor);}
}
try {
  // Measure core before loading the independent WASM render engine; its memory
  // is unrelated to the server writer. Verification still samples this process.
  await run(100_000,'customer');await run(1_000_000,'customer');await run(1_000_000,'admin');
  // Small actual output for independent Artifact Tool import/render QA.
  const { FileBlob,SpreadsheetFile } = await import('/Users/ersen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs');
  const sampleSpec=fixtureSpec(),sampleDir=join(directory,'sample');
  await preparePriceExport({input:sampleSpec,directory:sampleDir,fetchPage:fixtureSource(sampleSpec)});
  const sample=await assemblePriceExport({input:sampleSpec,directory:sampleDir});
  const workbook=await SpreadsheetFile.importXlsx(await FileBlob.load(join(sampleDir,sample.file)));
  const sheet=workbook.worksheets.getItemAt(0);
  assert.equal(sheet.getRange('A2').values[0][0],'0986479380');assert.equal(sheet.getRange('C2').values[0][0],1.23456);
  const image=await workbook.render({sheetName:'Price List 1',range:'A1:E7',scale:1,format:'png'});
  await writeFile(join(directory,'sample.png'),new Uint8Array(await image.arrayBuffer()),{flag:'wx'});
  report.sample={...sample,artifactToolImport:true,preview:join(directory,'sample.png')};
  // Same row values independently verified for both audiences, but different scope bindings.
  assert.notEqual(report.results[1].receipt.binding,report.results[2].receipt.binding);
  report.status='passed';
} catch(error) {report.status='failed';report.error=error.stack;process.exitCode=1;}
finally {
  report.finishedAt=new Date().toISOString();
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({report:join(directory,'report.json'),status:report.status}));
}
