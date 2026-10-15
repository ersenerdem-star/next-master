import {streamCsvRows,toCsv} from './csv';

// Kept in parity with the deployed worker amount parser; see preflight tests.
export function parseSupplierPriceAmount(value: unknown, { typedNumeric = false } = {}) {
  const text = String(value ?? "").trim();
  if (!text) return { value: null, ambiguous: false };
  if (typedNumeric) {
    const number = Number(text);
    return { value: Number.isFinite(number) ? number : null, ambiguous: false };
  }

  const plainNumber = /^[+-]?\d+$/;
  const leadingDecimal = /^[+-]?[.,]\d+$/;
  const singleSeparator = /^([+-]?\d+)([.,])(\d+)$/;
  const spaceGrouped = /^[+-]?\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?$/;
  const commaGrouped = /^[+-]?\d{1,3}(?:,\d{3}){2,}$/;
  const dotGrouped = /^[+-]?\d{1,3}(?:\.\d{3}){2,}$/;
  const commaGroupsDotDecimal = /^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/;
  const dotGroupsCommaDecimal = /^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/;
  let canonical = null;
  if (plainNumber.test(text)) canonical = text;
  else if (leadingDecimal.test(text)) canonical = text.replace(",", ".");
  else if (spaceGrouped.test(text)) canonical = text.replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  else if (commaGrouped.test(text)) canonical = text.replaceAll(",", "");
  else if (dotGrouped.test(text)) canonical = text.replaceAll(".", "");
  else if (commaGroupsDotDecimal.test(text)) canonical = text.replaceAll(",", "");
  else if (dotGroupsCommaDecimal.test(text)) canonical = text.replaceAll(".", "").replace(",", ".");
  else {
    const match = text.match(singleSeparator);
    if (match) {
      const integerDigits = match[1].replace(/^[+-]/, "");
      if (integerDigits.length <= 3 && match[3].length === 3) {
        return { value: null, ambiguous: true };
      }
      canonical = `${match[1]}.${match[3]}`;
    }
  }
  if (canonical === null) return { value: null, ambiguous: false };
  const number = Number(canonical);
  return { value: Number.isFinite(number) ? number : null, ambiguous: false };
}

export type SupplierCsvIssue={row:number;column:string;code:string;message:string};
export type SupplierCsvReport={totalRows:number;issueCount:number;counts:Record<string,number>;issues:SupplierCsvIssue[]};
const CODE_HEADERS=['product_code','part_no','part_number','partno','code','sku','article_number','article_no'];
const PRICE_HEADERS=['buy_price','buy_price_eur','buy_price_usd','buy_price_gbp','buy_price_try','supplier_price','price','net_price','purchase_price'];
export async function inspectSupplierCsv(file:Blob,signal:AbortSignal):Promise<SupplierCsvReport>{
 const report:SupplierCsvReport={totalRows:0,issueCount:0,counts:{},issues:[]};
 const add=(row:number,column:string,code:string,message:string)=>{
  report.issueCount++;report.counts[code]=(report.counts[code]||0)+1;
  // Bounded report memory. Counts cover every row; downloaded details are capped.
  if(report.issues.length<100000)report.issues.push({row,column,code,message});
 };
 let codeIndex=-1,priceIndex=-1,headerSeen=false;
 const codes=new Map<string,number>();
 for await(const cells of streamCsvRows(file)){
  signal.throwIfAborted();
  if(!headerSeen){
   headerSeen=true;
   const headers=cells.map(x=>x.trim().toLowerCase().replace(/[\s-]+/g,'_'));
   codeIndex=headers.findIndex(x=>CODE_HEADERS.includes(x));priceIndex=headers.findIndex(x=>PRICE_HEADERS.includes(x));
   if(codeIndex<0)add(1,'Product_Code','missing_header','Ürün kodu sütunu bulunamadı.');
   if(priceIndex<0)add(1,'Buy_Price','missing_header','Alış fiyatı sütunu bulunamadı.');
   if(codeIndex<0||priceIndex<0)return report;
   continue;
  }
  report.totalRows++;const row=report.totalRows+1;
  const code=(cells[codeIndex]||'').replace(/\s+/g,'').toUpperCase();
  if(!/[A-Z0-9]/.test(code))add(row,'Product_Code','missing_code','Ürün kodu boş veya geçersiz.');
  else if(codes.has(code))add(row,'Product_Code','duplicate_code',`Ürün kodu tekrar ediyor; ilk kayıt: ${codes.get(code)}.`);
  else codes.set(code,row);
  const price=(cells[priceIndex]||'').trim();const parsed=parseSupplierPriceAmount(price);
  if(!price)add(row,'Buy_Price','missing_price','Alış fiyatı boş.');
  else if(/[€$£₺]/.test(price))add(row,'Buy_Price','currency_symbol','Fiyat hücresindeki para birimi işaretini kaldırın; örnek: 14,19.');
  else if(parsed.ambiguous)add(row,'Buy_Price','ambiguous_price','Fiyatın ondalık/binlik ayrımı belirsiz; örnek: 1234 veya 1,2340.');
  else if(parsed.value===null||parsed.value<=0)add(row,'Buy_Price','invalid_price','Fiyat sıfırdan büyük, geçerli bir sayı olmalı.');
  if(report.totalRows%2000===0)await new Promise(resolve=>setTimeout(resolve,0));
 }
 if(!headerSeen)add(1,'','empty_file','Dosya boş.');
 else if(!report.totalRows&&!report.issueCount)add(2,'','empty_file','Dosyada ürün satırı yok.');
 return report;
}
export function supplierCsvIssueCsv(report:SupplierCsvReport){
 // Cells contain generated diagnostics only, never untrusted supplier values.
 return '\uFEFF'+toCsv([['CSV record (header = 1)','Column','Code','Problem'],...report.issues.map(x=>[x.row,x.column,x.code,x.message])]);
}
