import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preparePriceExport,assemblePriceExport } from './partitioned-price-export.mjs';
import { fixtureSpec,fixtureSource } from './local-export-fixture.mjs';

// No network adapter. This child is used solely by the own-process SIGKILL tests.
const [directory,mode,crashPhase]=process.argv.slice(2);
const input=fixtureSpec();
const checkpoint=async phase => {
  if (crashPhase!==phase) return;
  process.send({stage:'kill-checkpoint',phase});
  await new Promise(()=>{});
};
try {
  if (mode==='prepare') {
    await preparePriceExport({input,directory,
      fetchPage:fixtureSource(input,event=>appendFile(join(directory,'fetches.jsonl'),JSON.stringify(event)+'\n',{mode:0o600})),
      afterPart:async ({index})=>{if(index===1)await checkpoint('prepare');},
    });
  } else if(mode==='assemble') {
    await assemblePriceExport({input,directory,afterPartition:async({index})=>{if(index===1)await checkpoint('assemble');}});
  } else throw new Error('LOCAL_EXPORT_MODE_INVALID');
  process.send({stage:'complete'});
} catch(error) { process.send({stage:'failed',message:error.message});process.exitCode=1; }
