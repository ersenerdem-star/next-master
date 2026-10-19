// A Weight_kg field is a measurement: a single comma or dot is decimal,
// including three decimal places. It never uses buy-price ambiguity rules.
export function parseSupplierWeight(value) {
 const text=String(value??'').trim();if(!text)return null;
 let canonical=null;
 if(/^[+]?(?:\d+(?:[.,]\d{1,9})?|[.,]\d{1,9})$/.test(text))canonical=text.replace(',','.');
 else if(/^[+]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d{1,9})?$/.test(text))canonical=text.replace(/[ \u00a0\u202f]/g,'').replace(',','.');
 const n=canonical===null?NaN:Number(canonical);
 return Number.isFinite(n)&&n>0&&n<=1000000?n:null;
}
