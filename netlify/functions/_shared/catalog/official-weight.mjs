// Canonical logistics weight is gross kg, never an unlabeled/net value.
export function officialGrossWeightKg(criteria=[]){
 const rows=criteria.filter(c=>/\b(gross|brutto)\b/i.test(String(c.criteriaDescription||c.criteriaAbbrDescription||c.label||'')));
 if(!rows.length)return null;const values=[];
 for(const c of rows){const label=String(c.criteriaDescription||c.criteriaAbbrDescription||c.label||''),unit=String(c.criteriaUnitDescription||c.unit||label.match(/\[(kg|g)\]/i)?.[1]||'').trim().toLowerCase(),raw=String(c.formattedValue??c.rawValue??c.val??'').trim().replace(',','.');
 if(!/^\d+(\.\d+)?$/.test(raw)||!['g','kg'].includes(unit))return null;const kg=Number(raw)/(unit==='g'?1000:1);if(!(kg>0&&kg<=100000))return null;values.push(kg);}
 return new Set(values).size===1?values[0]:null;
}
