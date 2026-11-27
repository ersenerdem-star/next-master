import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { markupMoney, roundMoney } from '../../shared/order-money.mjs';

// Exercise the actual confirmation guard with a controlled supplier response.
function confirmationGuard(currentBuy: number) {
  const file = new URL('../../apps/web/src/presentation/pages/QuotesPage.tsx', import.meta.url);
  const source = ts.createSourceFile(file.pathname,readFileSync(file,'utf8'),ts.ScriptTarget.ES2022,true);
  const names = ['confirmationSku','assertCurrentPricesBeforeConfirmation'];
  const statements = names.map(name => {
    const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    assert.ok(node, `${name} not found`); return node.getText(source);
  });
  const compiled = ts.transpileModule(statements.join('\n'), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const dependencies = {
    fetchPreservedSupplierConfirmationLines: async () => new Set<number>(),
    callAppRpc: async () => [{request_index:0,has_published_scope:true,options:[
      {supplier_id:'b',supplier_name:'B',product_code:'0012',buy_price:currentBuy},
    ]}],
    markupMoney, roundMoney,
  };
  return new Function(...Object.keys(dependencies), `const exports = {}; ${compiled}; return assertCurrentPricesBeforeConfirmation;`)(...Object.values(dependencies));
}
const alternative = {
  brand:'Bosch',requestedCode:'0012',resolvedCode:'0012',qty:1,supplier_name:'B',buy_price:130,sell_price:110,
  manual_sell_price:false,supplier_override_keep_sell_price:true,selectedSupplierKey:'B-1',
  supplierOptions:[{supplier_id:'a',supplier_name:'A'},{supplier_id:'b',supplier_name:'B'}],
};

test('confirmation accepts a verified alternative purchase price while keeping the existing sale price', async () => {
  await confirmationGuard(130)([alternative],'A',10,15,'EUR');
});
test('supplier override never bypasses stale purchase price or missing sale checks', async () => {
  await assert.rejects(confirmationGuard(131)([alternative],'A',10,15,'EUR'),/Refresh this line/);
  await assert.rejects(confirmationGuard(130)([{...alternative,sell_price:null}],'A',10,15,'EUR'),/Refresh this line/);
});
test('ordinary automatic lines retain existing customer margin verification', async () => {
  await assert.rejects(confirmationGuard(130)([{...alternative,supplier_override_keep_sell_price:false}],'A',10,15,'EUR'),/Refresh this line/);
});
