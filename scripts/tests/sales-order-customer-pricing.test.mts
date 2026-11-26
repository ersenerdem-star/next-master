import test from 'node:test';
import assert from 'node:assert/strict';
import { applySalesOrderCustomerPricing } from '../../apps/web/src/shared/salesOrderCustomerPricing.ts';
import type { QuoteBuilderLine } from '../../apps/web/src/types/quoteBuilder.ts';

const makeLine = (overrides: Partial<QuoteBuilderLine> = {}): QuoteBuilderLine => ({
  lineId:'1', requestedCode:'0012', resolvedCode:'0012', brand:'Bosch', description:'', qty:1,
  oem_no:'', hs_code:'', origin:'', weight_kg:null, supplier_name:'Supplier', buy_price:100,
  sell_price:110, c_sell_price:null, manual_sell_price:false, price_date:'', notes:'',
  found:true, codeChanged:false, codeChangeWarning:'', selectedSupplierKey:'Supplier-0',
  supplierOptions:[{ supplier_name:'Supplier', buy_price:100, sell_price:110, price_date:null, notes:null }],
  ...overrides,
});
const ctx = (overrides = {}) => ({ workbenchMode:'new' as const, hasCustomerProfile:false, customerType:'A' as const, marginA:10, marginB:15, ...overrides });

test('unselected customer has no calculated sale price while supplier buy price is retained', () => {
  const [line] = applySalesOrderCustomerPricing([makeLine()], ctx());
  assert.equal(line.buy_price, 100);
  assert.equal(line.sell_price, null);
  assert.equal(line.supplierOptions[0].sell_price, null);
  assert.equal(line.customer_pricing_pending, true);
});

test('choosing customer A, B and custom margin prices the same supplier correctly', () => {
  const [pending] = applySalesOrderCustomerPricing([makeLine()], ctx());
  const [a] = applySalesOrderCustomerPricing([pending], ctx({hasCustomerProfile:true}));
  const [b] = applySalesOrderCustomerPricing([pending], ctx({hasCustomerProfile:true,customerType:'B'}));
  const [custom] = applySalesOrderCustomerPricing([pending], ctx({hasCustomerProfile:true,marginA:22}));
  assert.equal(a.sell_price,110); assert.equal(b.sell_price,115); assert.equal(custom.sell_price,122);
});

test('customer removal clears computed price but preserves deliberately entered manual price', () => {
  const computed = makeLine({sell_price:115});
  const manual = makeLine({lineId:'2',sell_price:139.5,manual_sell_price:true});
  const result = applySalesOrderCustomerPricing([computed,manual], ctx());
  assert.equal(result[0].sell_price,null);
  assert.equal(result[1].sell_price,139.5);
});

test('saved historical sale and manual prices remain unchanged on customer change', () => {
  const historical = makeLine({sell_price:87.65});
  const manual = makeLine({lineId:'2',sell_price:139.5,manual_sell_price:true});
  const result = applySalesOrderCustomerPricing([historical,manual], ctx({workbenchMode:'existing',hasCustomerProfile:true,customerType:'B'}));
  assert.equal(result[0].sell_price,87.65);
  assert.equal(result[1].sell_price,139.5);
});

test('a customerless saved draft prices only pending empty lines after choosing a customer', () => {
  const [pending] = applySalesOrderCustomerPricing([makeLine()], ctx());
  const priced = makeLine({lineId:'old',sell_price:73.5});
  const result = applySalesOrderCustomerPricing([pending,priced], ctx({workbenchMode:'existing',hasCustomerProfile:true,customerType:'B'}));
  assert.equal(result[0].sell_price,115);
  assert.equal(result[1].sell_price,73.5);
});

test('new lines appended after a customer is selected use the latest customer context', () => {
  const [pending] = applySalesOrderCustomerPricing([makeLine()], ctx());
  const [line] = applySalesOrderCustomerPricing([pending], ctx({hasCustomerProfile:true,customerType:'B'}));
  assert.equal(line.sell_price,115);
  const [changed] = applySalesOrderCustomerPricing([line], ctx({hasCustomerProfile:true,marginA:20}));
  assert.equal(changed.sell_price,120);
});

test('an invalid customer pricing setup cannot silently fall back to a default price', () => {
  const [line] = applySalesOrderCustomerPricing([makeLine()], ctx({hasCustomerProfile:true,customerType:'Other',pricingBlocked:true}));
  assert.equal(line.sell_price,null);
  assert.equal(line.supplierOptions[0].sell_price,null);
});
