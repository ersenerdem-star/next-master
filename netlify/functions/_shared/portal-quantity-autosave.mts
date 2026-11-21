import { buildRestUrl, getJson, sendJson, serviceRoleHeaders } from './http.mts';
import { isWahlerBrand } from '../../../shared/wahler-price-tiers.mjs';
import { multiplyMoney, salesOrderTotals } from '../../../shared/order-money.mjs';

type QuantityPriceInput = { code: string; brand: string; qty: number; market_segment?: string };
type QuantityPrice = {
  resolvedCode: string; brand: string; qty: number; supplier_name: string;
  buy_price: number | null; sell_price: number | null; price_date: string;
  applied_min_quantity?: number | null;
  supplierOptions?: unknown[];
  selectedSupplierKey?: string;
};

export type QuantityEdit = { index: number; code: string; previousQty: number; qty: number };
export function sameOrderVersion(a: string, b: string) {
  const micros = (value: string) => {
    const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(value);
    if (!match) return null;
    const fraction = (match[3] || '').padEnd(6, '0');
    const zone = /^[+-]\d{2}$/.test(match[4]) ? `${match[4]}:00` : match[4];
    const millis = Date.parse(`${match[1]}T${match[2]}.${fraction.slice(0, 3)}${zone}`);
    return Number.isFinite(millis) ? BigInt(millis) * 1000n + BigInt(fraction.slice(3)) : null;
  };
  const left = micros(a), right = micros(b);
  return left !== null && right !== null && left === right;
}
export function buildQuantityOnlyUpdate(order: Record<string, any>, edits: QuantityEdit[], prices: ReadonlyMap<number, QuantityPrice> = new Map()) {
  if (!Array.isArray(order.lines) || !Array.isArray(edits) || !edits.length || edits.length > 200) throw new Error('Invalid quantity changes.');
  const seen = new Set<number>();
  const lines = order.lines.map((line: Record<string, unknown>) => ({ ...line }));
  for (const edit of edits) {
    if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= lines.length || seen.has(edit.index) || !Number.isSafeInteger(edit.qty) || edit.qty < 1 || edit.qty > 2147483647) throw new Error('Invalid quantity changes.');
    seen.add(edit.index);
    const line = lines[edit.index];
    const code = String(line.resolvedCode || line.requestedCode || line.product_code || line.code || '').trim();
    if (code !== edit.code || Number(line.qty) !== edit.previousQty) throw new Error('Order changed elsewhere. Reload before saving quantities.');
    line.qty = edit.qty;
    const price = prices.get(edit.index);
    if (price) {
      if (price.qty !== edit.qty || price.resolvedCode.trim().toUpperCase() !== code.toUpperCase()
          || !isWahlerBrand(price.brand) || price.buy_price == null || price.sell_price == null
          || (line.supplier_name && line.supplier_name !== price.supplier_name)) {
        throw new Error('The Wahler quantity price could not be verified. Review the supplier and quantity before saving.');
      }
      line.buy_price = price.buy_price;
      if (!line.manual_sell_price) line.sell_price = price.sell_price;
      line.supplier_name = price.supplier_name;
      if (price.supplierOptions && price.selectedSupplierKey) {
        line.supplierOptions = price.supplierOptions;
        line.selectedSupplierKey = price.selectedSupplierKey;
      }
      line.price_date = price.price_date;
      line.applied_min_quantity = price.applied_min_quantity ?? null;
      line.quantity_priced_at_qty = edit.qty;
      line.requested_qty = null;
      line.quantity_adjusted = false;
      line.quantity_adjustment_note = null;
    }
    if ('line_total' in line || 'sales_total' in line) {
      const total = line.sell_price == null ? null : multiplyMoney(Number(line.sell_price), edit.qty);
      if ('line_total' in line) line.line_total = total;
      if ('sales_total' in line) line.sales_total = total;
    }
  }
  const totals = salesOrderTotals(lines, Number(order.shipping_cost || 0), Number(order.discount_amount || 0));
  return { lines, purchase_total: totals.purchase_total, sales_total: totals.sales_total, profit_total: totals.profit_total, margin_percent: totals.margin_percent };
}

export async function savePortalQuantities(url: string, key: string, invite: { id: string; organization_id: string; party_type: string; access_can_view_orders: boolean }, orderId: string, updatedAt: string, edits: QuantityEdit[],
  priceQuantities?: (rows: QuantityPriceInput[]) => Promise<QuantityPrice[]>,
) {
  if (invite.party_type !== 'customer' || !invite.access_can_view_orders || !orderId || !updatedAt) throw new Error('Order is not available.');
  const scope = { id:`eq.${orderId}`, organization_id:`eq.${invite.organization_id}`, portal_invite_id:`eq.${invite.id}`, source_channel:'eq.portal', status:'eq.draft', portal_submitted_at:'is.null' };
  const orders = await getJson<Array<Record<string, any>>>(buildRestUrl(url,'sales_orders',{...scope,select:'id,updated_at,lines,shipping_cost,discount_amount'}),{headers:serviceRoleHeaders(key)});
  const order = orders[0];
  if (!order || !sameOrderVersion(String(order.updated_at), updatedAt)) throw new Error('Order changed elsewhere. Reload before saving quantities.');
  const quantityOnly = buildQuantityOnlyUpdate(order, edits);
  const wahlerEdits = edits.filter(edit => isWahlerBrand(quantityOnly.lines[edit.index].brand));
  let update = quantityOnly;
  if (wahlerEdits.length) {
    const prices = await priceQuantities?.(wahlerEdits.map(edit => ({
      code: edit.code,
      brand: 'Wahler',
      qty: edit.qty,
      market_segment: String(quantityOnly.lines[edit.index].market_segment || ''),
    })));
    if (prices?.length !== wahlerEdits.length) throw new Error('The Wahler quantity price could not be verified.');
    update = buildQuantityOnlyUpdate(order, edits, new Map(wahlerEdits.map((edit, index) => [edit.index, prices[index]])));
  }
  const rows = await sendJson<Array<{updated_at:string}>>(buildRestUrl(url,'sales_orders',{...scope,updated_at:`eq.${order.updated_at}`,select:'updated_at'}),{
    method:'PATCH',headers:{...serviceRoleHeaders(key),Prefer:'return=representation'},body:JSON.stringify({...update,updated_at:new Date(Math.max(Date.now(),Date.parse(order.updated_at)+1)).toISOString()})
  });
  if (rows.length !== 1) throw new Error('Order changed elsewhere. Reload before saving quantities.');
  return {
    updatedAt: rows[0].updated_at,
    salesTotal: update.sales_total,
    prices: wahlerEdits.map(({ index }) => ({
      index,
      sellPrice: update.lines[index].sell_price as number | null,
    })),
  };
}
