import {useEffect,useState} from 'react';
import {supabaseClient} from '../../infrastructure/api/supabaseClient';
import {Button} from '../../presentation/components/common/Button';
import {downloadCsv,toCsv} from '../../shared/csv';
import {parseSupplierWeight} from '../../../../engine/supplier-price-shadow/src/supplier-weight.mjs';
type Sample={row:number;productCode:string;column:string;value:string;code:string;severity:string};
type Report={version:1;validatorVersion:string;issueCount:number;totalRows:number;counts:Record<string,number>;samples:Sample[];truncated:boolean};
const reasons:Record<string,[string,string]>={
 MISSING_PRODUCT_CODE:['Ürün kodu boş.','Product code is blank.'],DUPLICATE_PRODUCT_CODE:['Aynı ürün kodu dosyada tekrar ediyor. Tekilleştirin.','Product code is duplicated; resolve duplicate rows.'],
 MISSING_BUY_PRICE:['Alış fiyatı boş.','Buy price is blank.'],INVALID_BUY_PRICE:['Fiyat sıfırdan büyük bir sayı olmalı.','Price must be a positive number.'],
 AMBIGUOUS_BUY_PRICE_FORMAT:['Fiyatın binlik/ondalık ayrımı belirsiz; örnek: 1234 veya 1,2340.','Price separators are ambiguous; use 1234 or 1.2340.'],
 INVALID_WEIGHT:['Ağırlığı kg cinsinden pozitif sayı olarak girin; örnek: 0,355.','Enter a positive weight in kg, for example 0.355.'],
 INVALID_MOQ:['Asgari sipariş miktarı tam sayı olmalı.','MOQ must be a whole number.'],INVALID_LEAD_TIME:['Teslim süresi tam gün sayısı olmalı.','Lead time must be a whole number of days.'],
 INVALID_VALID_FROM:['Geçerli fiyat tarihi girin.','Enter a valid price date.'],MISSING_DATE:['Fiyat tarihi veya kaynak tarihi gerekli.','A price date or source date is required.'],
 MISSING_CURRENCY:['Para birimi eksik.','Currency is missing.'],INVALID_CURRENCY:['Para birimi üç harfli kod olmalı.','Use a three-letter currency code.'],UNSUPPORTED_CURRENCY:['Bu fiyat yüklemesi EUR destekliyor.','This price upload requires EUR.'],
};
export function sourceValidationReason(sample:Sample,version:string,tr:boolean){
 if(sample.code==='INVALID_WEIGHT'&&version.startsWith('legacy')&&parseSupplierWeight(sample.value)!==null)return tr?'Önceki sürüm bu ağırlık biçimini okuyamadı. Güncel sürüm bu değeri destekliyor.':'The previous version could not read this weight format. The current version supports this value.';
 return reasons[sample.code]?.[tr?0:1]||(tr?'Kaynak hücreyi kontrol edin.':'Check the source cell.');
}
function safeCsv(value:string){return /^[=+@-]/.test(value.trimStart())?`'${value}`:value;}
export function SupplierSourceValidationReport({releaseId,tr}:{releaseId:string;tr:boolean}){
 const [report,setReport]=useState<Report|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(false),[shown,setShown]=useState(20);
 useEffect(()=>{let active=true;setLoading(true);void Promise.resolve(supabaseClient.rpc('get_supplier_price_source_validation_report',{input_release_id:releaseId})).then(r=>{
  if(!active)return;if(r.error)throw Error();const d=r.data;
  if(d&&(d.version!==1||!Number.isSafeInteger(d.issueCount)||d.issueCount<1||!Array.isArray(d.samples)||d.samples.length>500||d.samples.some((s:Sample)=>!Number.isSafeInteger(s.row)||s.row<2||['productCode','column','value','code'].some(k=>typeof s[k as keyof Sample]!=='string'))))throw Error();
  setReport(d);setError(false);
 }).catch(()=>{if(active)setError(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[releaseId]);
 return <section className="list-stack" aria-label={tr?'Satır kontrol raporu':'Row validation report'}>
  <strong>{tr?'Satır kontrol raporu':'Row validation report'}</strong>
  {loading?<p role="status">{tr?'Hatalı kayıt ve hücreler yükleniyor…':'Loading problematic records and cells…'}</p>:error?<p role="alert" className="error-text">{tr?'Hata ayrıntıları alınamadı. Kaynak dosyayı değiştirmeden önce raporu doğrulayın.':'Error details are unavailable. Verify the report before changing the source file.'}</p>:!report?<p>{tr?'Bu eski işlem ayrıntılı rapor kaydetmemiş. Bu durum dosyadaki hangi hücrenin hatalı olduğunu doğrulamaz.':'This older run did not save detailed diagnostics; it does not identify an invalid source cell.'}</p>:<>
   <p>{tr?`${report.totalRows.toLocaleString('tr-TR')} kayıt kontrol edildi; ${report.issueCount.toLocaleString('tr-TR')} hücre/kod uyarısı.`:`${report.totalRows.toLocaleString()} records checked; ${report.issueCount.toLocaleString()} cell/code issues.`}</p>
   {report.validatorVersion.startsWith('legacy')?<p>{tr?'Bu rapor önceki işlem sürümünün sonucudur. Geçerli virgüllü ağırlıkların okunması güncel sürümde düzeltildi.':'This report describes the previous run. Valid decimal weight parsing has been corrected in the current version.'}</p>:null}
   <p>{tr?'Kayıt numarası başlık dahil CSV/Excel kaydıdır; başlık 1. kayıttır.':'Record numbers include the header as record 1.'}</p>
   <div className="table-wrap"><table className="data-table"><thead><tr>{(tr?['Kayıt','Parça no','Sütun','Hücre değeri','Neden / düzeltme']:['Record','Part no','Column','Cell value','Reason / correction']).map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{report.samples.slice(0,shown).map((s,i)=><tr key={`${s.row}:${s.code}:${i}`}><td>{s.row}</td><td>{s.productCode||'—'}</td><td>{s.column}</td><td><code>{s.value||'∅'}</code></td><td>{sourceValidationReason(s,report.validatorVersion,tr)}</td></tr>)}</tbody></table></div>
   {shown<report.samples.length?<Button variant="secondary" onClick={()=>setShown(v=>v+50)}>{tr?'Daha fazla kayıt':'More records'}</Button>:null}
   {report.truncated?<p>{tr?`Ayrıntılarda ilk ${report.samples.length} sorun gösterilir; toplam sayı dosyanın tamamını kapsar.`:`Details contain the first ${report.samples.length} issues; totals cover the full file.`}</p>:null}
   <Button variant="secondary" onClick={()=>downloadCsv(`supplier-upload-errors-${releaseId}.csv`,'\uFEFF'+toCsv([['Record (header=1)','Product_Code','Column','Value','Code',tr?'Düzeltme':'Correction'],...report.samples.map(s=>[s.row,safeCsv(s.productCode),s.column,safeCsv(s.value),s.code,sourceValidationReason(s,report.validatorVersion,tr)])]))}>{tr?'Hata listesini indir':'Download issue list'}</Button>
  </>}
 </section>;
}
