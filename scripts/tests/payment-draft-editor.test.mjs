import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initializePaymentDraft, newPaymentDraft, selectPaymentDraft, updatePaymentDraft } from '../../apps/web/src/shared/paymentDraftEditor.ts';

const old = {id:'existing-confirmed',invoice_id:'other-invoice',amount:.25,status:'confirmed'};
const fresh = {id:'new-draft',invoice_id:'new-invoice',amount:.5,status:'draft'};
const empty = {persistedId:'',draft:null};

test('late initial list loading cannot replace a new invoice-linked draft',()=>{
  const state=newPaymentDraft(fresh);
  assert.equal(initializePaymentDraft(state,[old]),state);
  assert.equal(state.persistedId,'');
  assert.equal(state.draft.invoice_id,'new-invoice');
});
test('add new after selecting existing cannot inherit its previous_id',()=>{
  let state=selectPaymentDraft(old);
  state=newPaymentDraft(fresh);
  state=initializePaymentDraft(state,[old]);
  assert.equal(state.persistedId,'');
  assert.equal(state.draft.id,'new-draft');
});
test('empty list reload never creates another ID or discards draft edits',()=>{
  const state=updatePaymentDraft(newPaymentDraft(fresh),d=>({...d,amount:12.5,notes:'typed'}));
  for(let n=0;n<5;n++) assert.equal(initializePaymentDraft(state,[]),state);
  assert.equal(state.draft.notes,'typed');
  assert.equal(state.draft.amount,12.5);
});
test('only uninitialized editor adopts the first fetched persisted row',()=>{
  assert.equal(initializePaymentDraft(empty,[]),empty);
  assert.deepEqual(initializePaymentDraft(empty,[old]),{persistedId:old.id,draft:old});
});
test('editing existing ID preserves original identity across list refresh',()=>{
  const state=updatePaymentDraft(selectPaymentDraft(old),d=>({...d,id:'renamed',amount:.5}));
  assert.equal(state.persistedId,old.id);
  assert.equal(initializePaymentDraft(state,[{...old,amount:999}]),state);
  assert.equal(state.draft.amount,.5);
});
test('explicit selection/save adopts new persisted ID without changing source',()=>{
  const state=selectPaymentDraft(fresh);
  state.draft.amount=1;
  assert.equal(fresh.amount,.5);
  assert.equal(state.persistedId,fresh.id);
  assert.deepEqual(selectPaymentDraft(old),{persistedId:old.id,draft:old});
});
test('received and made editors both use the shared lifecycle for new/save/selection',()=>{
  for(const [page,suffix] of [['Sales','Received'],['Purchases','Made']]){
    const source=fs.readFileSync(`apps/web/src/presentation/pages/${page}Page.tsx`,'utf8');
    assert.match(source,new RegExp(`usePaymentDraftEditor\\(payments${suffix}\\)`));
    assert.match(source,new RegExp(`startNewPayment${suffix}\\(next\\)`));
    assert.match(source,new RegExp(`selectPayment${suffix}\\(saved\\)`));
    assert.match(source,new RegExp(`selectPayment${suffix}\\(row\\)`));
    assert.doesNotMatch(source,new RegExp(`setSelectedPayment${suffix}Id`));
    assert.match(source,new RegExp(`const previousId = selectedPayment${suffix}Id`));
  }
});
