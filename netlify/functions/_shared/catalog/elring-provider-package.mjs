import { ELRING, FIELDS, codeKey, fingerprint } from "./elring-official-provider.mjs";

const canonicalValue = value => Array.isArray(value) ? value.map(canonicalValue)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalValue(value[key])])) : value;
const present = value => value != null && value !== '' && (typeof value !== 'object' || Object.keys(value).length > 0);

export function stageRows(observations) {
  return observations.map(o => ({ source_product_id: codeKey(o.fields.product_code), product_code: o.fields.product_code,
    description: o.fields.description, oem_no: o.fields.oem_no, market_segment: o.fields.market_segment,
    source_url: o.source_url, source_payload: o }));
}

export async function processPackage({ db, organizationId, brandId, observations, collectionKey, publish, approvalActor,
  approvalReference, checkpoint = {}, save = async () => {} }) {
  if (!observations.length || observations.length > 25) throw Error('PACKAGE_SIZE_MUST_BE_1_TO_25');
  if (observations.some(o => !o.fields.market_segment)) throw Error('MARKET_SEGMENT_REQUIRED: provide a reviewed --default-market-segment or source value');
  if (publish && observations.some(o => (o.limitations || []).some(l => /^vehicle_fitment_/.test(l)))) throw Error('COMPLETE_VEHICLE_FITMENT_REQUIRED_BEFORE_PUBLICATION');
  const rpc = async (name, args) => { const { data, error } = await db.rpc(name, args); if (error) throw Error(`${name}: ${error.message}`); return data; };
  const rows = stageRows(observations);
  {
    const run = await rpc('begin_or_resume_catalog_provider_stage', { input_organization_id: organizationId,
      input_source_key: ELRING.sourceKey, input_collection_key: collectionKey, input_brand: ELRING.brand,
      input_scope: { provider: ELRING.sourceKey, collector: 'run-elring-official-packages.mjs', manifest_fingerprint: fingerprint(rows),
        page_size: rows.length, automatic_finalize: false, canonical_write: false } });
    if (checkpoint.run_id && checkpoint.run_id !== run.run_id) throw Error('RESUME_RUN_MISMATCH');
    checkpoint.run_id = run.run_id; checkpoint.stage_status = run.status;
    if (run.status === 'staged') { checkpoint.sealed = true; checkpoint.state ||= 'reviewed'; }
    await save();
  }
  if (!checkpoint.sealed) {
    const params = { input_run_id: checkpoint.run_id, input_page_number: 0, input_page_size: rows.length,
      input_total_elements: rows.length, input_total_pages: 1, payload: rows };
    // Replaying the same immutable page is supported by the stage RPC; a
    // different payload for an existing collection key is rejected by the DB.
    if (checkpoint.stage_status !== 'staged') await rpc('stage_catalog_provider_identity_page', { ...params,
      input_source_url: ELRING.url, input_retrieved_at: observations[0].observed_at });
    await rpc('verify_catalog_provider_stage_page', params);
    await rpc('seal_catalog_provider_stage_strict', { input_run_id: checkpoint.run_id });
    checkpoint.sealed = true; checkpoint.state = 'reviewed'; await save();
  }
  if (!publish) return checkpoint;
  if (!checkpoint.publication) {
    let previous = -1;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await rpc('publish_catalog_provider_stage_batch', { input_run_id: checkpoint.run_id,
        input_brand_id: brandId, input_expected_rows: rows.length, input_approval_actor: approvalActor,
        input_approval_reference: approvalReference, input_batch_size: 25 });
      if (result.status === 'completed') { checkpoint.publication = result; break; }
      if (!Number.isInteger(result.processed_rows) || result.processed_rows <= previous) throw Error('PUBLICATION_NO_PROGRESS');
      previous = result.processed_rows;
    }
    if (!checkpoint.publication) throw Error('PUBLICATION_BATCH_LIMIT');
    checkpoint.state = 'published'; await save();
  }
  if (!checkpoint.enrichment) {
    checkpoint.enrichment = await rpc('enrich_elring_provider_stage_batch', { input_run_id: checkpoint.run_id,
      input_brand_id: brandId, input_offset: 0, input_batch_size: 25 });
    if (checkpoint.enrichment.processed !== rows.length) { delete checkpoint.enrichment; throw Error('ENRICHMENT_CARDINALITY_MISMATCH'); }
    checkpoint.state = 'enriched'; await save();
  }
  if (!checkpoint.lifecycle) {
    const result = await rpc('apply_elring_provider_lifecycle_batch', {input_run_id: checkpoint.run_id,
      input_brand_id: brandId, input_offset: 0, input_batch_size: 25});
    if (result.processed !== rows.length) throw Error('LIFECYCLE_CARDINALITY_MISMATCH');
    checkpoint.lifecycle = result; await save();
  }
  const { data, error } = await db.from('catalog_products').select(`id,normalized_code,${FIELDS.join(',')}`)
    .eq('organization_id', organizationId).eq('brand_id', brandId).in('normalized_code', rows.map(r => codeKey(r.product_code)));
  if (error) throw Error(`CANONICAL_REREAD: ${error.message}`);
  if (data.length !== rows.length || rows.some(r => !data.some(p => p.normalized_code === codeKey(r.product_code)))) throw Error('CANONICAL_REREAD_CARDINALITY_MISMATCH');
  const relations = await db.from('catalog_product_relations')
    .select('catalog_product_id,relation_type,related_brand,related_product_code,source_record_id')
    .eq('organization_id', organizationId).in('catalog_product_id',data.map(p=>p.id))
    .in('relation_type',['replacement','replaced_by'])
    .in('source_record_id',(checkpoint.lifecycle.outcomes || []).map(o=>o.source_record_id));
  if (relations.error) throw Error(`REPLACEMENT_REREAD: ${relations.error.message}`);
  checkpoint.replacement_outcomes = observations.map(o => {
    const product = data.find(p=>p.normalized_code===codeKey(o.fields.product_code));
    return {product_code:o.fields.product_code,source_check:o.lifecycle?.checks.replacement || 'unsupported',
      relations:(o.replacement_relations || []).map(edge=>{
        const relationType=edge.source_relation==='replaces'?'replacement':'replaced_by';
        const target=edge.source_relation==='replaces'?edge.old_code:edge.new_code;
        const sourceId=checkpoint.lifecycle.outcomes?.find(outcome=>codeKey(outcome.product_code)===codeKey(o.fields.product_code))?.source_record_id;
        const found=sourceId && relations.data.some(r=>r.catalog_product_id===product.id && r.source_record_id===sourceId && r.relation_type===relationType
          && r.related_brand?.toLowerCase()==='elring'
          && String(r.related_product_code).replace(/\s/g,'').toLowerCase()===String(target).replace(/\s/g,'').toLowerCase());
        if(!found) throw Error('REPLACEMENT_REREAD_MISMATCH');
        return {...edge,status:'verified_source_relation',operational_mapping:false};
      })};
  });
  checkpoint.canonical_coverage = Object.fromEntries(FIELDS.map(f => [f, data.filter(p => present(p[f])).length]));
  // Record source candidates alongside canonical outcomes; image candidates
  // remain pending controlled image review, never counted as applied images.
  checkpoint.field_outcomes = observations.map(o => ({ product_code: o.fields.product_code,
    fields: Object.fromEntries(FIELDS.map(f => {
      const canonical = data.find(p => p.normalized_code === codeKey(o.fields.product_code))[f];
      return [f, { source: o.field_status[f], canonical: canonical ?? null,
        status: o.field_status[f] === 'missing' ? 'source_missing' : f === 'image_url' ? 'review_required'
          : fingerprint(canonicalValue(canonical)) === fingerprint(canonicalValue(o.fields[f])) ? 'verified' : 'preserved_or_conflict' }];
    })) }));
  checkpoint.state = 'reread_verified'; await save(); return checkpoint;
}
