import {createHash} from 'node:crypto';
export const codeKey=s=>String(s||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
export const sha=s=>createHash('sha256').update(s).digest('hex');
export const decode=s=>String(s).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n));
const clean=s=>decode(String(s).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());
const unique=a=>[...new Set(a.filter(Boolean))].sort();
const regions='AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const names=new Intl.DisplayNames(['en'],{type:'region'});
const countries=new Map(regions.flatMap(c=>[[names.of(c).toLowerCase(),c],[c.toLowerCase(),c]]));
for(const [n,c] of Object.entries({'south korea':'KR','korea':'KR','czech republic':'CZ','turkey':'TR','türkiye':'TR','usa':'US','uk':'GB','russian federation':'RU','taiwan, province of china':'TW'}))countries.set(n,c);
export function validGtin(value){
 const s=String(value||'').trim();if(!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(s))return false;
 const digits=[...s].map(Number),check=digits.pop();let sum=0;for(let i=digits.length-1,n=0;i>=0;i--,n++)sum+=digits[i]*(n%2?1:3);return(10-sum%10)%10===check;
}
export function parseElringSpareto(html,url,expected){
 const u=new URL(url);if(u.origin!=='https://spareto.com'||!u.pathname.startsWith('/products/elring-')||u.search)throw Error('SPARETO_URL_SCOPE');
 const items=[...html.matchAll(/data-variant-card-gtm-item-value='([^']+)'/g)].map(m=>JSON.parse(decode(m[1])));
 const item=items.find(i=>i.item_list_id==='variant');
 if(!item||item.item_brand!=='ELRING'||codeKey(item.item_id)!==codeKey(expected)||codeKey(u.pathname.split('/').at(-1))!==codeKey(expected))throw Error('SPARETO_EXACT_IDENTITY');
 const properties={};for(const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
  const c=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>clean(m[1]));if(c.length===2){
   if(properties[c[0]]&&properties[c[0]]!==c[1]){if(['Weight','Customs Code','Country of Origin','EAN','GTIN','Barcode','Market Segment','Market segment'].includes(c[0]))throw Error('SPARETO_AMBIGUOUS_PROPERTY');properties[c[0]]=unique([...[properties[c[0]]].flat(),c[1]]);}
   else properties[c[0]]=c[1];
  }
 }
 const fields={};const weight=properties.Weight?.match(/^([\d.,]+)\s*(kg|g)$/i);
 if(weight){const n=Number(weight[1].replace(',','.'))/(weight[2].toLowerCase()==='g'?1000:1);if(Number.isFinite(n)&&n>0&&n<=1000)fields.weight_kg=n;}
 if(/^\d{6,12}$/.test(properties['Customs Code']||''))fields.hs_code=properties['Customs Code'];
 const origin=countries.get(properties['Country of Origin']?.toLowerCase());if(origin)fields.origin=origin;
 let image=html.match(/<meta\s+content=['"]([^'"]+)['"]\s+property=['"]og:image['"]/i)?.[1];
 if(image){image=decode(image);if(/^https:\/\/cdn\.spareto\.com\/variants\/images\//.test(image)&&!/(placeholder|noimage|no-image|default)/i.test(image))fields.image_url=image;}
 const eans=unique(['EAN','GTIN','Barcode'].map(k=>properties[k]).filter(validGtin));
 // Only Product JSON-LD with this exact SKU is eligible; organization and
 // alternative-product JSON must never supply another article's GTIN.
 const visit=v=>{if(Array.isArray(v))return v.forEach(visit);if(!v||typeof v!=='object')return;
  if(v['@type']==='Product'&&codeKey(v.sku||v.mpn)===codeKey(expected)){for(const k of ['gtin','gtin8','gtin12','gtin13','gtin14'])if(validGtin(v[k]))eans.push(String(v[k]));}
  if(v['@graph'])visit(v['@graph']);};
 for(const m of html.matchAll(/<script[^>]+type=['"]application\/ld\+json['"][^>]*>([\s\S]*?)<\/script>/gi)){try{visit(JSON.parse(m[1]));}catch{}}
 if(unique(eans).length===1)fields.ean=eans[0];
 const section=html.match(/<h3[^>]*>OE Numbers<\/h3>([\s\S]*?)(?:<h3|<\/section>)/i)?.[1]||'';
 const oe=unique([...section.matchAll(/<a[^>]+href=['"]\/oe\/[^'"]+['"][^>]*>([\s\S]*?)<\/a>/gi)].map(m=>clean(m[1])));if(oe.length)fields.oem_no=oe.join(', ');
 const vehicleSection=html.match(/<section[^>]+id=['"]nav-vehicles['"][^>]*>([\s\S]*?)<\/section>/i)?.[1]||'';
 const makes=unique([...vehicleSection.matchAll(/<div[^>]*class=['"]col-6['"][^>]*style=['"][^'"]*font-weight:\s*bold[^'"]*['"][^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=['"]col-5['"][^>]*>\s*\d+\s+vehicles?\s*<\/div>/gi)].map(m=>clean(m[1])));
 const models=unique([...vehicleSection.matchAll(/<div[^>]*class=['"]col-6 ps-4['"][^>]*>([\s\S]*?)<\/div>/gi)].map(m=>clean(m[1])));
 if(makes.length)fields.vehicle=makes.join(', ');if(models.length)fields.vehicle_model=models.join(', ');
 // Engine is a product category, not evidence of market segment.
 const segments={pc:'pc','passenger cars':'pc',cv:'cv','commercial vehicles':'cv',lcv:'lcv','light commercial vehicles':'lcv',motorcycle:'motorcycle',marine:'marine',industrial:'industrial',agriculture:'agriculture',universal:'universal',engines:'engines'};
 const explicit=properties['Market Segment']||properties['Market segment'];if(explicit&&segments[explicit.toLowerCase()])fields.market_segment=segments[explicit.toLowerCase()];
 return{schema_version:'elring-spareto.v1',product_code:expected,source_product_code:item.item_id,brand:'ELRING',source_url:url,html_sha256:sha(html),raw_item:item,raw_properties:properties,fields,vehicle_scope:'page_make_model_summary_only',retrieved_at:new Date().toISOString()};
}
