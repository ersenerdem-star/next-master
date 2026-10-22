import {test} from 'node:test';import assert from 'node:assert/strict';
import {catalogReviewOutcome} from '../../apps/web/src/presentation/components/common/catalogReviewOutcome.ts';
test('real reviewed Elring description, EAN and missing origin have distinct outcomes',()=>{
 const item={observation:{before:{description:'IWDR AL/PTFE crankshaft Ø85mm',ean:'4041248525906',origin:null},sourceFields:{description:'Shaft Seal, crankshaft',ean:'4041248525906'},fields:{}},result:{fields:{description:'source_missing',ean:'source_missing',origin:'source_missing'}}};
 assert.equal(catalogReviewOutcome(item,'description'),'existing_value_preserved');assert.equal(catalogReviewOutcome(item,'ean'),'unchanged');assert.equal(catalogReviewOutcome(item,'origin'),'source_missing');
 assert.equal(item.result.fields.description,'source_missing');
});
test('explicit applied, concurrent-edit and identity-conflict receipts are never relabelled',()=>{
 for(const outcome of ['applied','changed_since_review','ean_identity_conflict'])assert.equal(catalogReviewOutcome({observation:{before:{ean:'1111111111111'},sourceFields:{ean:'2222222222222'},fields:{}},result:{fields:{ean:outcome}}},'ean'),outcome);
});
