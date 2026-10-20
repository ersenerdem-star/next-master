import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePage,validateCollection,mapBaseArticle} from '../catalog/collect-elring-official-catalog.mjs';
const article=code=>({articleNumber:code,mfrName:'ELRING',dataSupplierId:10});
const page=()=>({status:200,totalMatchingArticles:2,maxAllowedPage:1,articles:[article('000.140'),article('001.100')]});
test('brand collection rejects truncated windows and changing totals',()=>{
  assert.equal(validatePage(page(),{prefix:'0'}),1);
  assert.throws(()=>validatePage({...page(),totalMatchingArticles:30000}),/WINDOW/);
  assert.throws(()=>validatePage(page(),{expectedTotal:3}),/TOTAL_CHANGED/);
  assert.throws(()=>validatePage({...page(),articles:[article('000.140')]}),/CARDINALITY/);
});
test('brand pages reject cross-brand, prefix leaks and normalized duplicate identities',()=>{
  for(const a of [{...article('000.140'),dataSupplierId:11},article('100.140'),article('000140')]){
    assert.throws(()=>validatePage({...page(),articles:[article('000.140'),a]},{prefix:'0'}),/IDENTITY|PREFIX/);
  }
});
test('full collection must account for every unique source product',()=>{
  validateCollection(page().articles,2);
  assert.throws(()=>validateCollection(page().articles,3),/CARDINALITY/);
  assert.throws(()=>validateCollection([article('000.140'),article('000140')],2),/CARDINALITY/);
});
test('component dimension conflicts preserve raw evidence without guessing one dimension',()=>{
  const a={...article('000.140'),articleCriteria:[{criteriaDescription:'Inner Diameter [mm]',criteriaUnitDescription:'mm',rawValue:'5'},
    {criteriaDescription:'Inner Diameter [mm]',criteriaUnitDescription:'mm',rawValue:'6'}]};
  const o=mapBaseArticle(a);assert.equal(o.raw,a);assert.equal(o.fields.dimensions,null);assert.equal(o.field_status.dimensions,'conflict');
});
