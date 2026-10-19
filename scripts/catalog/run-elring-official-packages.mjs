#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { resolveSyncEnvValue } from '../shared/load-sync-env.mjs';
import { ELRING, FIELDS, codeKey, fingerprint, assertSource, readElringArticle } from './lib/elring-official-provider.mjs';

import { processPackage } from "../../netlify/functions/_shared/catalog/elring-provider-package.mjs";
export { processPackage, stageRows } from "../../netlify/functions/_shared/catalog/elring-provider-package.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORG = '1e4c5e99-e387-41aa-a6d3-cbe74558f766';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) { const [key, inline] = argv[i].replace(/^--/, '').split(/=(.*)/s);
    args[key] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true); }
  if (args.help) { console.log('Elring official packages: --codes 115.100[,code] | --codes-file codes.json --output artifacts/elring/run.json --mode probe|stage|publish [--default-market-segment pc] [--fitment-max-requests 128] [--confirm-production --approved-by actor --approval-reference ref]\nUse node --import tsx scripts/catalog/run-elring-official-packages.mjs. A codes file must be a JSON array. Resume with the same output and manifest.'); return; }
  const mode = args.mode || 'probe';
  if (!['probe','stage','publish'].includes(mode)) throw Error('INVALID_MODE');
  if (mode !== 'probe' && args['confirm-production'] !== true) throw Error('CONFIRM_PRODUCTION_REQUIRED');
  const input = args['codes-file'] ? JSON.parse(await fs.readFile(path.resolve(args['codes-file']), 'utf8')) : String(args.codes || '').split(',');
  if (!Array.isArray(input) || input.some(c => typeof c !== 'string')) throw Error('CODES_MUST_BE_JSON_STRING_ARRAY');
  const codes = [...new Map(input.map(c => [codeKey(c), c.trim()]).filter(([key]) => key)).values()];
  if (!codes.length || codes.length > 10000) throw Error('CODE_MANIFEST_REQUIRED_MAX_10000');
  const organizationId = args['organization-id'] || ORG;
  const output = path.resolve(args.output || 'artifacts/elring/run.json');
  const fitmentMaxRequests = Number(args['fitment-max-requests'] || 128);
  const manifest = { adapterVersion: 'elring-official.v2', organizationId, source: ELRING.sourceKey, codes, defaultMarketSegment: args['default-market-segment'] || null,
    withFitment: true, fitmentMaxRequests };
  let report;
  try { report = JSON.parse(await fs.readFile(output, 'utf8')); if (report.manifest_fingerprint !== fingerprint(manifest)) throw Error('RESUME_MANIFEST_MISMATCH'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; report = { manifest, manifest_fingerprint: fingerprint(manifest), packages: [], started_at: new Date().toISOString() }; }
  const save = async () => { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(`${output}.tmp`, JSON.stringify(report, null, 2)); await fs.rename(`${output}.tmp`, output); };
  let db, brandId;
  if (mode !== 'probe') {
    const url = resolveSyncEnvValue('SUPABASE_URL', { projectRoot: ROOT });
    const key = resolveSyncEnvValue('SUPABASE_SERVICE_ROLE_KEY', { projectRoot: ROOT });
    if (!url || !key) throw Error('SUPABASE_CONFIGURATION_REQUIRED');
    db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(60000), redirect: 'error' }) } });
    const source = await db.from('catalog_external_sources').select('*').eq('organization_id', organizationId).eq('source_key', ELRING.sourceKey).single();
    if (source.error) throw Error(source.error.message);
    assertSource(source.data, { publish: mode === 'publish', approvalActor: args['approved-by'], approvalReference: args['approval-reference'] });
    const brand = await db.from('brands').select('id').eq('organization_id', organizationId).eq('name', ELRING.brand).single();
    if (brand.error) throw Error(brand.error.message); brandId = brand.data.id;
  }
  report.last_mode = mode; await save();
  for (let offset = 0; offset < codes.length; offset += 25) {
    const index = offset / 25;
    const pkg = report.packages[index] ||= { index, codes: codes.slice(offset, offset + 25), observations: [], checkpoint: {} };
    try {
      for (let n = pkg.observations.length; n < pkg.codes.length; n++) {
        // Serial requests; wait before each request, including across packages
        // and resume, to enforce the registered minimum interval.
        await sleep(1100);
        pkg.observations.push(await readElringArticle(pkg.codes[n], { defaultMarketSegment: manifest.defaultMarketSegment,
          withFitment: true, fitmentMaxRequests }));
        await save();
      }
      pkg.source_coverage = Object.fromEntries(FIELDS.map(f => [f, pkg.observations.filter(o => o.field_status[f] === 'present').length]));
      if (mode !== 'probe') await processPackage({ db, organizationId, brandId, observations: pkg.observations,
        collectionKey: `elring-exact-${report.manifest_fingerprint.slice(0,32)}-${index}`,
        publish: mode === 'publish', approvalActor: args['approved-by'], approvalReference: args['approval-reference'], checkpoint: pkg.checkpoint, save });
      delete pkg.error; await save(); console.log(JSON.stringify({ package: index, state: pkg.checkpoint.state || 'observed', source_coverage: pkg.source_coverage }));
    } catch (error) { pkg.error = error.message; report.status = 'failed'; await save(); throw error; }
  }
  report.status = mode === 'probe' ? 'observed' : mode === 'stage' ? 'reviewed' : 'reread_verified';
  report.finished_at = new Date().toISOString(); await save(); console.log(JSON.stringify({ status: report.status, artifact: output }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
