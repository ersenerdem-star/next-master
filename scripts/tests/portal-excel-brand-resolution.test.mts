import test from 'node:test';
import assert from 'node:assert/strict';
import { planExcelBrandResolution, applyExcelBrandChoices } from '../../apps/web/src/modules/portal/excelBrandResolution.ts';

const brands = ['Mercedes-Benz','Knorr-Bremse','Victor Reinz','Nural','Kolbenschmidt','VDO/Continental','KKK','BorgWarner (KKK)','Beru','BorgWarner (BERU)','Continental','Continental CTAM','TRW','TRW Engine Components'];
const row = (code:string,brand:string,qty=1) => ({code,brand,qty});

test('verified unique aliases preserve code and quantity; ambiguous brands require selection per row', () => {
  const plan = planExcelBrandResolution([row('001','Mercedes',2),row('002','knorr'),row('003','Reinz'),row('004','NÜRAL'),row('005','KS'),row('006','VDO'),row('007','KKK'),row('008','KKK')],brands);
  assert.deepEqual(plan.resolved.slice(0,6).map(x=>x.brand),['Mercedes-Benz','Knorr-Bremse','Victor Reinz','Nural','Kolbenschmidt','VDO/Continental']);
  assert.deepEqual(plan.choices.map(x=>[x.index,x.code,x.options]),[[6,'007',['KKK','BorgWarner (KKK)']],[7,'008',['KKK','BorgWarner (KKK)']]]);
  assert.throws(()=>applyExcelBrandChoices(plan.resolved,plan.choices,{6:'KKK'}),/Choose a brand/);
  const selected = applyExcelBrandChoices(plan.resolved,plan.choices,{6:'KKK',7:'BorgWarner (KKK)'});
  assert.deepEqual([selected[0].code,selected[0].qty,selected[6].brand,selected[7].brand],['001',2,'KKK','BorgWarner (KKK)']);
  assert.equal(selected[6].brand_choice_confirmed,true);
});

test('unknown names require an explicit choice; scope limits choices; new matching records become ambiguous', () => {
  const p=planExcelBrandResolution([row('1','KKN'),row('2','KKK')],['KKK','BorgWarner (KKK)']);
  assert.equal(p.choices.length,2);
  assert.deepEqual(p.choices[0].options,['KKK','BorgWarner (KKK)']);
  const restricted=planExcelBrandResolution([row('2','KKK')],['BorgWarner (KKK)']);
  assert.equal(restricted.choices.length,1);
  assert.deepEqual(restricted.choices[0].options,['BorgWarner (KKK)']);
  assert.throws(()=>applyExcelBrandChoices(restricted.resolved,restricted.choices,{0:'KKK'}),/Choose a brand/);
  assert.equal(planExcelBrandResolution([row('3','VDO')],['VDO','VDO/Continental']).choices.length,1);
  assert.throws(()=>planExcelBrandResolution([row('4','Mercedes')],['Mercedes-Benz','mercedes-benz']),/Duplicate brand/);
});
