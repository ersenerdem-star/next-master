// Synthetic source only; no URL, Supabase credentials or business rows.
import {createHash} from 'node:crypto';
export const fixtureSpec = (count=6, overrides={}) => ({
  tenantId:'synthetic-tenant',requesterId:'synthetic-requester',audience:'customer',
  customerId:'synthetic-customer',snapshotId:'immutable-snapshot-1',
  pricingVersion:'synthetic-pricing-1',brand:'Bosch',currency:'EUR',
  expectedRows:count,pageSize:2,...overrides,
});
export function fixtureRow(ordinal,spec) {
  return {code:String(986479379+ordinal).padStart(10,'0'),brand:spec.brand,
    description:ordinal===1 ? '=1+1' : `Synthetic filter ${ordinal} – Türkçe`,
    price:'1.23456',currency:spec.currency,priceDate:'2026-10-04',
    discontinued:ordinal===2,replacementCode:ordinal===2 ? '0000123456' : '',
    supplier_notes:'DO-NOT-EXPORT-PRIVATE-NOTE',buy_price:'DO-NOT-EXPORT-COST'};
}
export function largeFixtureRow(ordinal,spec){
  // Repeatable high-entropy descriptions force an actual XLSX beyond one TUS
  // chunk. No million-row supplier fixture is re-uploaded for this test.
  const description=Array.from({length:280},(_,i)=>createHash('sha256').update(`${ordinal}:${i}`).digest('base64')).join('');
  return {...fixtureRow(ordinal,spec),description};
}
export function fixtureSource(input, onFetch=()=>{},rowFactory=fixtureRow) {
  return async ({spec,binding,after,limit}) => {
    const start=after == null ? 1 : Number(after)-986479379+1;
    const end=Math.min(input.expectedRows,start+limit-1);
    await onFetch({start,end,binding});
    const rows=Array.from({length:Math.max(0,end-start+1)},(_,i)=>rowFactory(start+i,spec));
    return {binding,expectedRows:input.expectedRows,rows,
      done:end===input.expectedRows,nextCursor:end===input.expectedRows ? null : rows.at(-1)?.code};
  };
}
