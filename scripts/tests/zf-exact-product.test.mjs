import test from 'node:test';
import assert from 'node:assert/strict';
import {ZF_BRANDS,exactZfSearchItem,assertZfArticleIdentity,zfArticleWeight,zfReplacementCandidates} from '../../netlify/functions/_shared/catalog/zf-product-identity.mjs';
import {readZfOfficialProduct} from '../../netlify/functions/_shared/catalog/zf-aftermarket-sync.mts';
test('every ZF brand requires exact brand and punctuation-preserving article identity',()=>{
 for(const brand of Object.values(ZF_BRANDS)){
  const right={source_article_number:'61 / 1',source_brand_name:brand};
  const wrong={source_article_number:'611',source_brand_name:brand};
  assert.equal(exactZfSearchItem([wrong,right],'61/1',brand),right);
  assert.throws(()=>exactZfSearchItem([wrong],'61/1',brand),/NOT_FOUND/);
  assert.throws(()=>exactZfSearchItem([{...right,source_brand_name:'TRW Engine Components'}],'61/1',brand),/NOT_FOUND/);
  assert.throws(()=>exactZfSearchItem([right,right],'61/1',brand),/AMBIGUOUS/);
  assert.throws(()=>assertZfArticleIdentity({details:{number:'611',brandName:brand}},'61/1',brand),/NOT_FOUND/);
  assert.throws(()=>assertZfArticleIdentity({details:{number:'61/1',brandName:'Wrong'}},'61/1',brand),/NOT_FOUND/);
 }
 assert.doesNotThrow(()=>assertZfArticleIdentity({details:{number:'123 45',brandName:'LEMFÖRDER'}},'12345','Lemforder'));
});
test('gross kg weight respects units and refuses conflicting variants or inferred units',()=>{
 assert.equal(zfArticleWeight({productTypes:[{netWeight:'4,18',grossWeight:'4,33',weightUnit:'kg'}]}),4.33);
 assert.equal(zfArticleWeight({productTypes:[{grossWeight:'4330',weightUnit:'g'}]}),4.33);
 for(const types of [[{grossWeight:'4330'}],[{grossWeight:'4.33',weightUnit:'lb'}],[{grossWeight:'-1',weightUnit:'kg'}],
  [{grossWeight:'4.33',weightUnit:'kg'},{grossWeight:'9',weightUnit:'kg'}]])assert.equal(zfArticleWeight({productTypes:types}),null);
 assert.equal(zfArticleWeight({mainStage:{weight:{label:'Gross Weight (kg)',value:'0,355'}}}),0.355);
 assert.equal(zfArticleWeight({mainStage:{weight:{label:'Weight',value:'4330'}}}),null);
});
test('ZF nested explicit replacement values retain direction and do not consume unrelated parts lists',()=>{
 assert.deepEqual(zfReplacementCandidates({number:'318 189',replacedBy:{label:'Replaced by',values:[{text:'350 038',href:'/products/350+038'}]},partsList:{values:[{text:'999'}]}}),
  [{code:'350 038',direction:'replaced_by',brand:null}]);
 assert.deepEqual(zfReplacementCandidates({number:'1',replacedBy:{values:[{text:'1'},{text:'? bad'}]}}),[]);
});
test('actual reader uses the exact spaced source article URL and checks the returned brand before mapping fields',async()=>{
 const original=globalThis.fetch;const requests=[];
 const details={number:'350 038',brandName:'SACHS',name:'Shock Absorber, driver cab suspension',status:{key:1,value:'Normal'},
  mainStage:{ean:{value:'4059923045922'}},productTypes:[{netWeight:'4,18',grossWeight:'4,33',weightUnit:'kg'}]};
 let wrong=false;
 globalThis.fetch=async url=>{requests.push(String(url));return Response.json(String(url).includes('/api/search')?
  {products:{items:[{productNumber:'350 038',brandName:'SACHS',name:details.name}],pagination:{totalItems:1}}}:
  {details:{...details,brandName:wrong?'BOGE':'SACHS'},specifications:{}});};
 try{
  const result=await readZfOfficialProduct('Sachs','350038');
  assert.equal(result.fields.weight_kg,4.33);assert.equal(result.fields.ean,'4059923045922');assert.equal(result.fields.description,details.name);
  assert.ok(requests.some(url=>url.includes('/api/articles/350%20038')));assert.equal(requests.length,1,'Exact six-digit SACHS details do not need a repeated search');
  wrong=true;await assert.rejects(readZfOfficialProduct('Sachs','350038'),/NOT_FOUND/);
 }finally{globalThis.fetch=original;}
});
