import { buildRestUrl, getJson, sendJson, serviceRoleHeaders } from './http.mts';
import { salesOrderTotals } from '../../../shared/order-money.mjs';

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
export function buildQuantityOnlyUpdate(order: Record<string, any>, edits: QuantityEdit[]) {
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
  }
  const totals = salesOrderTotals(lines, Number(order.shipping_cost || 0), Number(order.discount_amount || 0));
  return { lines, purchase_total: totals.purchase_total, sales_total: totals.sales_total, profit_total: totals.profit_total, margin_percent: totals.margin_percent };
}

export async function savePortalQuantities(url: string, key: string, invite: { id: string; organization_id: string; party_type: string; access_can_view_orders: boolean }, orderId: string, updatedAt: string, edits: QuantityEdit[]) {
  if (invite.party_type !== 'customer' || !invite.access_can_view_orders || !orderId || !updatedAt) throw new Error('Order is not available.');
  const scope = { id:`eq.${orderId}`, organization_id:`eq.${invite.organization_id}`, portal_invite_id:`eq.${invite.id}`, source_channel:'eq.portal', status:'eq.draft', portal_submitted_at:'is.null' };
  const orders = await getJson<Array<Record<string, any>>>(buildRestUrl(url,'sales_orders',{...scope,select:'id,updated_at,lines,shipping_cost,discount_amount'}),{headers:serviceRoleHeaders(key)});
  const order = orders[0];
  if (!order || !sameOrderVersion(String(order.updated_at), updatedAt)) throw new Error('Order changed elsewhere. Reload before saving quantities.');
  const update = buildQuantityOnlyUpdate(order,edits);
  const rows = await sendJson<Array<{updated_at:string}>>(buildRestUrl(url,'sales_orders',{...scope,updated_at:`eq.${order.updated_at}`,select:'updated_at'}),{
    method:'PATCH',headers:{...serviceRoleHeaders(key),Prefer:'return=representation'},body:JSON.stringify({...update,updated_at:new Date(Math.max(Date.now(),Date.parse(order.updated_at)+1)).toISOString()})
  });
  if (rows.length !== 1) throw new Error('Order changed elsewhere. Reload before saving quantities.');
  return { updatedAt: rows[0].updated_at, salesTotal: update.sales_total };
}
