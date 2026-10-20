import test from 'node:test';
import assert from 'node:assert/strict';
import { mapElringArticle, readElringArticle, readElringFitment, buildArticleRequest, assertSource, ELRING } from '../catalog/lib/elring-official-provider.mjs';
import { processPackage } from '../catalog/run-elring-official-packages.mjs';

const criterion = (label, raw, unit) => ({ criteriaDescription: label, rawValue: raw, formattedValue: raw, criteriaUnitDescription: unit });
const article = (extra = {}) => ({ dataSupplierId: 10, mfrName: 'ELRING', articleNumber: '115.100',
  genericArticles: [{ genericArticleDescription: 'Seal Ring, oil drain plug' }], gtins: ['4041248445976'], ...extra });
const observation = () => ({ ...mapElringArticle(article(), { defaultMarketSegment: 'pc' }), observed_at: '2026-10-19T00:00:00Z' });
const response = data => new Response(JSON.stringify({ status: 200, totalMatchingArticles: 1, articles: [article()], ...data }));

test('all requested fields exist; optional absence remains explicit', () => {
  const row = mapElringArticle(article());
  for (const key of ['weight_kg','hs_code','origin','vehicle','vehicle_model','market_segment','dimensions','image_url','description_tr']) {
    assert.equal(row.fields[key], null); assert.equal(row.field_status[key], 'missing');
  }
  assert.equal(row.fields.ean, '4041248445976');
});
test('tariff uses raw digits; dimensions and weight preserve units and precision', () => {
  const row = mapElringArticle(article({ articleCriteria: [criterion('Inner Diameter [mm]','14','mm'),
    criterion('Thickness [mm]','1,5','mm'), criterion('Length [cm]','2','cm'),
    { ...criterion('Goods tariff number','7415210000'), formattedValue: '7,415,210,000' }],
    articleLogisticsCriteria: [criterion('Net Weight','1,25','g'),criterion('Country of origin','Germany')] }));
  assert.equal(row.fields.hs_code, '7415210000'); assert.equal(row.fields.weight_kg, .00125);
  assert.equal(row.fields.origin, 'Germany'); assert.deepEqual(row.fields.dimensions, { inner_diameter_mm: 14, thickness_mm: 1.5, length_mm: 20 });
});
test('unknown or invalid units never become guessed kilograms or dimensions', () => {
  const row = mapElringArticle(article({ articleCriteria: [criterion('Weight','12','lb'),criterion('Length','5','inch')] }));
  assert.equal(row.fields.weight_kg,null); assert.equal(row.fields.dimensions,null);
});
test('OEM codes retain original identity and do not invent vehicle compatibility', () => {
  const row = mapElringArticle(article({ oemNumbers: [{ articleNumber: 'A 007 603 01 41 06', mfrName: 'MERCEDES-BENZ' }] }));
  assert.equal(row.fields.oem_no,'A 007 603 01 41 06'); assert.equal(row.fields.vehicle,null); assert.equal(row.fields.vehicle_model,null);
});
test('explicit fitment fields and partial linkage warning are retained', () => {
  const row = mapElringArticle(article({ linkages: [{mfrName:'AUDI',vehicleModelSeriesName:'A4'}],totalLinkages:5 }));
  assert.equal(row.fields.vehicle,'AUDI'); assert.equal(row.fields.vehicle_model,'A4');
  assert.ok(row.limitations.includes('vehicle_linkages_incomplete'));
});
test('wrong brand, supplier, requested identity and ambiguous dimensions fail closed', () => {
  for (const extra of [{mfrName:'OTHER'},{dataSupplierId:9},{articleNumber:'999.999'}])
    assert.throws(() => mapElringArticle(article(extra),{requestedCode:'115100'}), /IDENTITY/);
  assert.throws(() => mapElringArticle(article({articleCriteria:[criterion('Length','1','mm'),criterion('Length','2','mm')]})),/AMBIGUOUS/);
});
test('image candidates stay HTTPS review evidence and prices are never requested', () => {
  const row = mapElringArticle(article({images:[{imageURL1600:'http://unsafe.invalid/a.jpg'},{imageURL800:'https://digital-assets.tecalliance.services/a.jpg'}]}));
  assert.equal(row.fields.image_url,'https://digital-assets.tecalliance.services/a.jpg');
  assert.ok(row.limitations.includes('image_requires_controlled_review_apply'));
  assert.equal(buildArticleRequest('115.100').getArticles.includePrices,false);
  assert.equal(buildArticleRequest('115.100').getArticles.includeReplacesArticles,true);
  assert.equal(buildArticleRequest('115.100').getArticles.includeReplacedByArticles,true);
});
test('replacement direction is explicit, same-brand and separate from discontinuation',()=>{
  const o=mapElringArticle(article({mfrId:510,misc:{articleStatusDescription:'Normal'},
    replacesArticles:[{articleNumber:'001.000',mfrName:'ELRING'}],
    replacedByArticles:[{articleNumber:'300.000',mfrId:510},{articleNumber:'400.000',mfrName:'OTHER'},{articleNumber:'500.000'}]}));
  assert.equal(o.fields.lifecycle_status,null);
  assert.deepEqual(o.replacement_relations.map(e=>[e.old_code,e.new_code]),[['001.000','115.100'],['115.100','300.000']]);
  assert.equal(o.lifecycle.evidence.replacement.rejected_relations,2);
});
test('only an explicit discontinued production statement sets lifecycle status',()=>{
  for(const label of ['Out of stock','Unavailable','No longer deliverable','Superseded','Normal']) {
    assert.equal(mapElringArticle(article({misc:{articleStatusId:99,articleStatusDescription:label}})).fields.lifecycle_status,null);
  }
  const o=mapElringArticle(article({misc:{articleStatusDescription:'Production discontinued'}}));
  assert.equal(o.fields.lifecycle_status,'discontinued');assert.equal(o.fields.lifecycle_note,'Elring official status: Production discontinued');
});
test('contradictory replacement directions fail rather than being published',()=>{
  assert.throws(()=>mapElringArticle(article({replacesArticles:[{mfrName:'ELRING',articleNumber:'300.000'}],
    replacedByArticles:[{mfrName:'ELRING',articleNumber:'300.000'}]})),/DIRECTION_CONFLICT/);
});
test('reader filters exact identities from prefix results, rejects truncation and ambiguity', async () => {
  const row = await readElringArticle('115100',{fetchImpl:async()=>response({totalMatchingArticles:2,articles:[article({articleNumber:'115.100X'}),article()]})});
  assert.equal(row.fields.product_code,'115.100');
  await assert.rejects(readElringArticle('115.100',{fetchImpl:async()=>response({totalMatchingArticles:101})}), /TRUNCATED/);
  await assert.rejects(readElringArticle('115.100',{fetchImpl:async()=>response({articles:[article(),article()]})}), /AMBIGUOUS/);
  await assert.rejects(readElringArticle('115.100',{fetchImpl:async()=>new Response('oops',{status:503})}), /HTTP_503/);
});
test('observation authorization does not imply publication authorization', () => {
  const source = { source_key: ELRING.sourceKey,base_url:ELRING.url,is_active:true,license_posture:'allowed',credential_boundary:'none',rate_limit_posture:'bounded',
    metadata:{allowed_brands:['Elring'],automated_read_only_approved:true,internal_observation_allowed:true} };
  assert.doesNotThrow(()=>assertSource(source)); assert.throws(()=>assertSource(source,{publish:true}),/PUBLICATION/);
  source.metadata={...source.metadata,internal_catalog_persistence_allowed:true,approval_actor:'owner',publication_approval_reference:'decision'};
  assert.doesNotThrow(()=>assertSource(source,{publish:true,approvalActor:'owner',approvalReference:'decision'}));
});

test('official fitment chain resolves manufacturers and models from linked vehicle details', async () => {
  const methods=[];
  const fetchImpl=async (_url, init)=>{
    const request=JSON.parse(init.body);const method=Object.keys(request)[0];methods.push(method);
    const array=method==='getArticles'?null:method==='getArticleLinkedAllLinkingTargetManufacturer2'?[{manuId:5,manuName:'AUDI'}]
      :method==='getArticleLinkedAllLinkingTarget4'?[{articleLinkages:{array:[{articleLinkId:1,linkingTargetId:2}]}}]
        :[{linkedVehicles:{array:[{manuDesc:'AUDI',modelDesc:'A4',carId:2}]}}];
    return response(method==='getArticles'?{articles:[article({genericArticles:[{legacyArticleId:42,linkageTargetTypes:['V']} ]})]}:{data:{array}});
  };
  const result=await readElringArticle('115.100',{fetchImpl,withFitment:true,wait:async()=>{}});
  assert.equal(result.fields.vehicle,'AUDI'); assert.equal(result.fields.vehicle_model,'AUDI A4');
  assert.equal(result.fitment.complete,true);assert.equal(result.fitment.evidence.length,3);
  assert.deepEqual(methods,['getArticles','getArticleLinkedAllLinkingTargetManufacturer2','getArticleLinkedAllLinkingTarget4','getArticleLinkedAllLinkingTargetsByIds3']);
});
test('fitment request budget marks incomplete and cannot reach publication', async()=>{
  const fitment=await readElringFitment(article({genericArticles:[{legacyArticleId:42,linkageTargetTypes:['V']}]}),{
    maxRequests:1,wait:async()=>{},fetchImpl:async()=>response({data:{array:[{manuId:5}]}})});
  assert.equal(fitment.complete,false);assert.equal(fitment.requests,1);
  const o=observation();o.limitations.push('vehicle_fitment_request_budget_exhausted');
  const db=mockDb();await assert.rejects(process(db,{observations:[o],publish:true}),/COMPLETE_VEHICLE_FITMENT_REQUIRED/);
  assert.equal(db.calls.length,0);
});

function mockDb({ failAt, resumed = false, relations = [], canonicalFields = {} } = {}) {
  const calls = [];
  const db = { calls, rpc: async(name,args) => { calls.push(name);
    if (name === failAt) return {error:{message:'injected failure'}};
    return {data: name === 'begin_or_resume_catalog_provider_stage' ? {run_id:'run',status:resumed?'staged':'provider_collecting'}
      : name === 'publish_catalog_provider_stage_batch' ? {status:'completed'}
        : name==='apply_elring_provider_lifecycle_batch' ? {processed:1,outcomes:[{product_code:'115.100',source_record_id:'source'}]}
          : name==='enrich_elring_provider_stage_batch' ? {processed:1} : {}};
  }, from:table=>table==='catalog_product_relations'
    ? {select:()=>({eq:()=>({in:()=>({in:()=>({in:async()=>({data:relations})})})})})}
    : ({ select:()=>({ eq:()=>({ eq:()=>({ in:async()=>({data:[{id:'p',normalized_code:'115100',...observation().fields,...canonicalFields}]}) }) }) }) }) };
  return db;
}
const process = (db, options = {}) => processPackage({db,organizationId:'org',brandId:'brand',observations:[observation()],collectionKey:'test',...options});
test('stage-only calls no canonical publisher or enrichment', async () => {
  const db=mockDb(); const cp=await process(db);
  assert.equal(cp.state,'reviewed'); assert.equal(db.calls.length,4);
  assert.ok(!db.calls.includes('publish_catalog_provider_stage_batch'));
});
test('publication failure prevents enrichment and retains durable staged checkpoint', async () => {
  const db=mockDb({failAt:'publish_catalog_provider_stage_batch'}); const checkpoint={};
  await assert.rejects(process(db,{publish:true,checkpoint}),/injected failure/);
  assert.equal(checkpoint.state,'reviewed'); assert.equal(checkpoint.sealed,true);
  assert.ok(!db.calls.includes('enrich_elring_provider_stage_batch'));
});
test('resume after sealing recovers DB state and reaches canonical reread', async () => {
  const db=mockDb({resumed:true}); const cp=await process(db,{publish:true});
  assert.equal(cp.state,'reread_verified'); assert.ok(!db.calls.includes('verify_catalog_provider_stage_page'));
  assert.deepEqual(db.calls,['begin_or_resume_catalog_provider_stage','publish_catalog_provider_stage_batch','enrich_elring_provider_stage_batch','apply_elring_provider_lifecycle_batch']);
});
test('lifecycle failure prevents a verified completion and remains resumable',async()=>{
  const db=mockDb({failAt:'apply_elring_provider_lifecycle_batch',resumed:true});const checkpoint={};
  await assert.rejects(process(db,{publish:true,checkpoint}),/injected failure/);
  assert.equal(checkpoint.state,'enriched');assert.equal(checkpoint.lifecycle,undefined);
});
test('replacement reread verifies the source-bound directed relation',async()=>{
  const o={...observation(),...mapElringArticle(article({replacedByArticles:[{articleNumber:'300.000',mfrName:'ELRING'}]}),{defaultMarketSegment:'pc'})};
  const db=mockDb({resumed:true,relations:[{catalog_product_id:'p',source_record_id:'source',relation_type:'replaced_by',related_brand:'Elring',related_product_code:'300.000'}]});
  const cp=await process(db,{publish:true,observations:[o]});
  assert.equal(cp.replacement_outcomes[0].relations[0].status,'verified_source_relation');
});
test('a reverse or historically sourced relation cannot satisfy the replacement reread',async()=>{
  const o={...observation(),...mapElringArticle(article({replacedByArticles:[{articleNumber:'300.000',mfrName:'ELRING'}]}),{defaultMarketSegment:'pc'})};
  for(const extra of [{source_record_id:'old-source',relation_type:'replaced_by'},{source_record_id:'source',relation_type:'replacement'}]) {
    const db=mockDb({resumed:true,relations:[{catalog_product_id:'p',related_brand:'Elring',related_product_code:'300.000',...extra}]});
    await assert.rejects(process(db,{publish:true,observations:[o]}),/REPLACEMENT_REREAD_MISMATCH/);
  }
});
test('missing segment prevents staging rather than silently classifying a part', async () => {
  const db=mockDb(); await assert.rejects(process(db,{observations:[mapElringArticle(article())]}),/MARKET_SEGMENT_REQUIRED/);
  assert.equal(db.calls.length,0);
});
test('JSONB key order does not create a false dimensions conflict and empty objects are not coverage',async()=>{
  const o=observation();o.fields.dimensions={width_mm:20,length_mm:10};o.field_status.dimensions='present';
  const db=mockDb({resumed:true,canonicalFields:{dimensions:{length_mm:10,width_mm:20}}});
  const cp=await process(db,{publish:true,observations:[o]});assert.equal(cp.field_outcomes[0].fields.dimensions.status,'verified');
  const empty=await process(mockDb({resumed:true,canonicalFields:{dimensions:{}}}),{publish:true});
  assert.equal(empty.canonical_coverage.dimensions,0);
});
