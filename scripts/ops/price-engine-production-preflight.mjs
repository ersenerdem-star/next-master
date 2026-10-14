#!/usr/bin/env node
// Offline promotion planner. It has no database, provider or deployment client.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultManifest = resolve(repoRoot, 'scripts/ops/price-engine-production-manifest.json');

export function inspectSnapshot(envelope, { phase = 'runtime', expectedProject, reference } = {}) {
  const errors = [];
  const data = envelope?.data;
  if (!expectedProject || envelope?.project_ref !== expectedProject) errors.push('PROJECT_TARGET_UNCONFIRMED');
  if (data?.snapshot_version !== 1) errors.push('SNAPSHOT_SCHEMA_UNCONFIRMED');
  if (!['baseline', 'runtime'].includes(phase)) errors.push('PREFLIGHT_PHASE_INVALID');
  const requiredSections = ['tables','columns','functions','indexes','buckets','job_constraints','policies','schemas'];
  for (const section of requiredSections) if (!Array.isArray(data?.[section])) errors.push(`SNAPSHOT_SECTION_MISSING:${section}`);
  const expectedCounts = { tables:32,columns:36,functions:52,indexes:9,buckets:4,schemas:2 };
  for (const [section,count] of Object.entries(expectedCounts)) {
    if (data?.[section]?.length !== count) errors.push(`SNAPSHOT_REQUIREMENTS_INCOMPLETE:${section}`);
  }
  if (errors.length) return { ready: false, phase, errors };
  const required = row => phase === 'runtime' || row.phase === 'baseline';
  for (const table of data.tables.filter(required)) {
    if (!table.present) errors.push(`TABLE_MISSING:${table.name}`);
    else if (table.exposed_schema && !table.rls) errors.push(`RLS_DISABLED:${table.name}`);
    if (table.restricted_browser && table.present) {
      if (table.anon_access || table.authenticated_access) errors.push(`DIRECT_BROWSER_JOB_ACCESS:${table.name}`);
      if (table.name === 'app_export_jobs' && (!table.service_select || !table.service_insert || !table.service_update || table.service_delete))
        errors.push(`JOB_SERVICE_GRANTS_INCOMPATIBLE:${table.name}`);
    }
  }
  for (const column of data.columns.filter(required)) {
    if (!column.compatible) errors.push(`COLUMN_INCOMPATIBLE:${column.table_name}.${column.column_name}`);
  }
  for (const fn of data.functions.filter(required)) {
    if (!fn.present) errors.push(`FUNCTION_MISSING:${fn.signature || fn.name}`);
    if (fn.service_only && fn.present && (!fn.service_execute || fn.anon_execute || fn.authenticated_execute))
      errors.push(`FUNCTION_SCOPE_INCOMPATIBLE:${fn.name}`);
    if (fn.authenticated_storage_predicate && fn.present && (!fn.authenticated_execute || fn.anon_execute || fn.service_execute))
      errors.push(`STORAGE_PREDICATE_SCOPE_INCOMPATIBLE:${fn.name}`);
    if (fn.private_helper && fn.present && (fn.anon_execute || fn.authenticated_execute || (fn.owner_only && fn.service_execute)))
      errors.push(`PRIVATE_HELPER_SCOPE_INCOMPATIBLE:${fn.name}`);
  }
  if (phase === 'runtime') {
    for (const schema of data.schemas) {
      if (!schema.present || schema.anon_usage || schema.authenticated_usage || schema.service_usage)
        errors.push(`PRIVATE_SCHEMA_SCOPE_INCOMPATIBLE:${schema.name}`);
    }
    for (const index of data.indexes) {
      if (!index.present || !index.valid || !index.ready) errors.push(`INDEX_UNAVAILABLE:${index.name}`);
    }
    for (const bucket of data.buckets) {
      if (!bucket.private || !bucket.size_compatible || !bucket.binary_compatible)
        errors.push(`BUCKET_INCOMPATIBLE:${bucket.name}`);
    }
    const types = ['admin_price_list','portal_price_list','catalog_master','catalog_export','supplier_report','supplier_price_list'];
    const typeGuard = data.job_constraints.some(c => c.validated && types.every(type => c.definition?.includes(`'${type}'`)));
    if (!typeGuard) errors.push('EXPORT_TYPE_CONSTRAINT_INCOMPATIBLE');
    if (!reference || reference.project_ref !== 'kaxsqafdevabkxofwdod' || reference.data?.snapshot_version !== 1) {
      errors.push('STAGING_REFERENCE_UNCONFIRMED');
    } else {
      const referenceFunctions = new Map(reference.data.functions?.map(fn => [fn.signature || fn.name, fn]) || []);
      for (const fn of data.functions.filter(fn => fn.phase === 'runtime' && fn.present && fn.reference_required !== false)) {
        const peer = referenceFunctions.get(fn.signature || fn.name);
        const fingerprint = f => JSON.stringify((f?.overloads || [])
          .map(o => [o.signature, o.definition_md5, o.security_definer, [...(o.config || [])].sort()]).sort());
        if (!peer?.present || fingerprint(fn) !== fingerprint(peer)) errors.push(`FUNCTION_DRIFT:${fn.name}`);
      }
    }
  }
  return { ready: errors.length === 0, phase, errors, project_ref: envelope.project_ref,
    collected_at: data.collected_at,
    evidence_scope: 'Read-only metadata only; provider env, worker liveness and business canaries remain separate.' };
}

export function inspectManifest(manifest, { loadFile = file => readFileSync(resolve(repoRoot, file)) } = {}) {
  const errors = [];
  if (manifest?.schema_version !== 1 || manifest?.environment !== 'production-preparation') errors.push('MANIFEST_SCHEMA_INVALID');
  const entries = manifest?.migration_order || [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.file || !entry.sha256) { errors.push(`MIGRATION_CAPTURE_PENDING:${entry.id}`); continue; }
    if (!/^supabase\/migrations\/[a-z0-9_]+\.sql$/.test(entry.file)) { errors.push(`MIGRATION_PATH_INVALID:${entry.id}`); continue; }
    if (seen.has(entry.file)) errors.push(`MIGRATION_DUPLICATED:${entry.file}`);
    seen.add(entry.file);
    try {
      const bytes = loadFile(entry.file);
      if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) errors.push(`MIGRATION_CHANGED:${entry.file}`);
    } catch { errors.push(`MIGRATION_FILE_MISSING:${entry.file}`); }
    if (entry.file.includes('supplier_price_staging_publication')) errors.push('STAGING_PUBLICATION_CANNOT_BE_PROMOTED');
  }
  for (const item of manifest?.required_acceptance || []) {
    if (item.status !== 'passed') errors.push(`ACCEPTANCE_PENDING:${item.id}`);
  }
  for (const entry of manifest?.controlled_data_operations || []) {
    if (!/^scripts\/ops\/[a-z0-9_-]+\.sql$/.test(entry.file || '') || !entry.sha256) {
      errors.push(`DATA_OPERATION_CAPTURE_PENDING:${entry.id}`); continue;
    }
    try {
      if (createHash('sha256').update(loadFile(entry.file)).digest('hex') !== entry.sha256)
        errors.push(`DATA_OPERATION_CHANGED:${entry.file}`);
    } catch { errors.push(`DATA_OPERATION_FILE_MISSING:${entry.file}`); }
    if (entry.applied !== true) errors.push(`DATA_OPERATION_PENDING:${entry.id}`);
  }
  return { ready: errors.length === 0, errors, migration_count: entries.length };
}

function parseArgs(args) {
  const options = { phase: 'baseline', manifest: defaultManifest };
  for (let i=0; i<args.length; i++) {
    const key = args[i];
    if (key === '--help') { options.help = true; continue; }
    if (!['--snapshot','--reference','--manifest','--phase','--project-ref'].includes(key) || !args[i+1]) throw Error(`Unknown or incomplete option: ${key}`);
    options[key.slice(2).replace('project-ref','projectRef')] = args[++i];
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Offline, read-only planner. No remote changes or connections.\n' +
      'node scripts/ops/price-engine-production-preflight.mjs [--manifest file]\n' +
      '  --snapshot production.json --project-ref zjgueqijumzlfioihnkt --phase baseline\n' +
      '  --snapshot production.json --reference staging.json --project-ref zjgueqijumzlfioihnkt --phase runtime\n' +
      'Snapshot envelopes: {project_ref: <connector target>, data: <price_engine_preflight SQL result>}.');
    return;
  }
  const manifest = JSON.parse(readFileSync(options.manifest,'utf8'));
  const plan = inspectManifest(manifest);
  const result = { action: 'prepare-only', mutation_performed: false, manifest: plan,
    migration_order: manifest.migration_order.map(({id,file,phase}) => ({id,file,phase})),
    unresolved: manifest.unresolved };
  if (options.snapshot) {
    const envelope = JSON.parse(readFileSync(options.snapshot,'utf8'));
    const reference = options.reference && JSON.parse(readFileSync(options.reference,'utf8'));
    result.preflight = inspectSnapshot(envelope, { phase: options.phase, expectedProject: options.projectRef, reference });
  }
  result.production_ready = Boolean(plan.ready && result.preflight?.ready && options.phase === 'runtime');
  console.log(JSON.stringify(result,null,2));
  if (options.snapshot && (!result.preflight.ready || (options.phase === 'runtime' && !result.production_ready))) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode=1; }
}
