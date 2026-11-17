import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFirstSaveMatchesPreview, firstSaveOrderId } from '../../netlify/functions/_shared/portal-first-save-guard.mts';
const preview=[{code:'P550428',brand:'Donaldson',qty:14,sell_price:2.4},{code:'P1',brand:'Donaldson',qty:2,sell_price:null}];
const prepared=preview.map(x=>({requestedCode:x.code,brand:x.brand,qty:x.qty,sell_price:x.sell_price}));
test('accepts exact preview including missing prices without changing values',()=>{assert.doesNotThrow(()=>assertFirstSaveMatchesPreview(preview,prepared));});
test('rejects changed prices, quantities, missing rows and duplicate codes',()=>{
  assert.throws(()=>assertFirstSaveMatchesPreview(preview,[{...prepared[0],sell_price:2.5},prepared[1]]));
  assert.throws(()=>assertFirstSaveMatchesPreview(preview,[{...prepared[0],qty:60},prepared[1]]));
  assert.throws(()=>assertFirstSaveMatchesPreview(preview,[prepared[0]]));
  assert.throws(()=>assertFirstSaveMatchesPreview([preview[0],preview[0]],[prepared[0],prepared[0]]));
});
test('retry identifiers are stable and scoped to both customer and organization',()=>{
  const token='a'.repeat(32), first=firstSaveOrderId('org','invite',token);
  assert.equal(first,firstSaveOrderId('org','invite',token));
  assert.notEqual(first,firstSaveOrderId('org','other',token));
  assert.notEqual(first,firstSaveOrderId('other','invite',token));
  assert.throws(()=>firstSaveOrderId('org','invite','invalid'));
});
