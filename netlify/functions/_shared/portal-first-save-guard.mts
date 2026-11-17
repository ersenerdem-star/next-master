import { createHash } from 'node:crypto';
type Expected = {code:string;brand:string;qty:number;sell_price:number|null};
type Prepared = {requestedCode:string;brand:string;qty:number;sell_price:number|null};
const key = (brand:string, code:string) => `${brand.trim().toLowerCase()}::${code.trim().toUpperCase().replace(/\s+/g,'')}`;

export function firstSaveOrderId(organizationId:string,inviteId:string,intentId:string) {
  if (!/^[a-f0-9]{32}$/i.test(intentId)) throw new Error('Invalid save request.');
  const digest=createHash('sha256').update(JSON.stringify([organizationId,inviteId,intentId.toLowerCase()])).digest('hex');
  return `portal-auto-${digest}`;
}

// The first automatic save must not silently replace the prices the customer
// saw while preparing the list. Duplicates are rejected rather than merged.
export function assertFirstSaveMatchesPreview(expected:Expected[], prepared:Prepared[]) {
  if (!Array.isArray(expected) || !expected.length || expected.length !== prepared.length) throw new Error('The list changed while saving. Review it before retrying.');
  const rows = new Map<string,Expected>();
  for (const row of expected) {
    if (!row || typeof row.code !== 'string' || typeof row.brand !== 'string' || !Number.isSafeInteger(row.qty) || row.qty < 1 || (row.sell_price !== null && (typeof row.sell_price !== 'number' || !Number.isFinite(row.sell_price) || row.sell_price < 0))) throw new Error('Invalid list preview.');
    const id=key(row.brand,row.code);
    if (!row.code.trim() || !row.brand.trim() || rows.has(id)) throw new Error('The list contains duplicate or invalid items.');
    rows.set(id,row);
  }
  for (const line of prepared) {
    const id=key(line.brand,line.requestedCode), preview=rows.get(id);
    if (!preview || preview.qty !== line.qty || preview.sell_price !== line.sell_price) throw new Error('A price or quantity changed while saving. Review the list before retrying.');
    rows.delete(id);
  }
  if (rows.size) throw new Error('The list changed while saving. Review it before retrying.');
}
