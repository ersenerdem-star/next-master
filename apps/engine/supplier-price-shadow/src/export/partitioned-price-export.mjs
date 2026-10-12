// C1/C2a artifact core, NOT an authenticated production endpoint.
// DBOS will own orchestration; these functions own immutable data artifacts only.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, open, link, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import {DeterministicWorkbookWriter} from './deterministic-workbook-writer.mjs';

const MAX_SHEET_ROWS = 1048575; // Header consumes the remaining Excel row.
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_PARTS = 10000;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(`EXPORT_${message}`); };
function text(value, max = 160, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max
    || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('TEXT_INVALID');
  return value;
}
export function exportSpec(input) {
  if (!input || !['admin', 'customer'].includes(input.audience)) fail('AUDIENCE_INVALID');
  const allowed = ['tenantId','requesterId','audience','customerId','snapshotId','pricingVersion','brand','currency','expectedRows','pageSize','sheetRows'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('SPEC_UNKNOWN_FIELD');
  const spec = {
    schema: 'customer-safe-price-list-v1', tenantId: text(input.tenantId),
    requesterId: text(input.requesterId), audience: input.audience,
    customerId: input.customerId == null ? null : text(input.customerId),
    snapshotId: text(input.snapshotId), pricingVersion: text(input.pricingVersion),
    brand: text(input.brand), currency: text(input.currency,3),
    expectedRows: input.expectedRows, pageSize: input.pageSize ?? 5000,
    sheetRows: input.sheetRows ?? MAX_SHEET_ROWS,
  };
  if (spec.audience === 'customer' && !spec.customerId) fail('CUSTOMER_REQUIRED');
  if (!/^[A-Z]{3}$/.test(spec.currency)) fail('CURRENCY_INVALID');
  if (!Number.isSafeInteger(spec.expectedRows) || spec.expectedRows < 1 || spec.expectedRows > 10_000_000) fail('EXPECTED_ROWS_INVALID');
  if (!Number.isInteger(spec.pageSize) || spec.pageSize < 1 || spec.pageSize > 5000) fail('PAGE_SIZE_INVALID');
  if (Math.ceil(spec.expectedRows / spec.pageSize) > MAX_PARTS) fail('PARTITION_BUDGET_EXCEEDED');
  if (!Number.isInteger(spec.sheetRows) || spec.sheetRows < 1 || spec.sheetRows > MAX_SHEET_ROWS) fail('SHEET_ROWS_INVALID');
  return Object.freeze(spec);
}
export function exportBinding(input) { return hash(JSON.stringify(exportSpec(input))); }
function safeRow(row, spec) {
  if (!row || row.brand !== spec.brand || row.currency !== spec.currency) fail('ROW_SCOPE_MISMATCH');
  const code = text(row.code,160);
  // Numeric strings retain precision through storage. Excel supports 15 significant
  // digits; reject values that cannot be represented by this commercial schema.
  if (typeof row.price !== 'string' || !/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(row.price)
    || Number(row.price) <= 0 || Number(row.price).toFixed((row.price.split('.')[1] || '').length) !== row.price) fail('PRICE_INVALID');
  const date = text(row.priceDate,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0,10) !== date) fail('DATE_INVALID');
  if (typeof row.discontinued !== 'boolean') fail('LIFECYCLE_INVALID');
  // Explicit whitelist: supplier costs, notes, email, OEM and images never enter parts.
  if(row.cursorKey!=null&&(typeof row.cursorKey!=='string'||!/^\d{12}$/.test(row.cursorKey)
    ||Number(row.cursorKey)<1||Number(row.cursorKey)>spec.expectedRows))fail('ROW_CURSOR_INVALID');
  return { code, ...(row.cursorKey==null?{}:{cursorKey:row.cursorKey}),brand: spec.brand, description: text(row.description ?? '',32767,true),
    price: row.price, currency: spec.currency, priceDate: date,
    discontinued: row.discontinued, replacementCode: text(row.replacementCode ?? '',160,true) };
}
export {safeRow as customerSafeExportRow};
async function fileHash(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) fail('FILE_TYPE_INVALID');
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { digest.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: digest.digest('hex') };
}
async function jsonIfPresent(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) fail('FILE_TYPE_INVALID');
    if (info.size > MAX_PART_BYTES) fail('ARTIFACT_TOO_LARGE');
    return JSON.parse(await readFile(path,'utf8'));
  } catch(error) { if (error.code === 'ENOENT') return null; throw error; }
}
// Same-directory atomic create, never replace an existing artifact. A local disk
// adapter is not distributed fencing or a Supabase object-store authorization gate.
async function putOnce(path, value) {
  const bytes = JSON.stringify(value), temp = `${path}.${randomUUID()}.tmp`;
  if (Buffer.byteLength(bytes) > MAX_PART_BYTES) fail('ARTIFACT_TOO_LARGE');
  const fd = await open(temp,'wx',0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  try { await link(temp,path); }
  catch(error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path,'utf8') !== bytes) fail('IMMUTABLE_WRITE_CONFLICT');
  } finally { await unlink(temp); }
}
function validatePart(record, { spec, binding, index, startAfter, processed }) {
  const { payload, sha256 } = record || {};
  if (!payload || hash(JSON.stringify(payload)) !== sha256) fail('PART_CHECKSUM_MISMATCH');
  if (payload.binding !== binding || payload.index !== index || payload.startAfter !== startAfter
    || payload.ordinalStart !== processed + 1 || !Array.isArray(payload.rows)
    || !payload.rows.length || payload.rows.length > spec.pageSize
    || processed + payload.rows.length > spec.expectedRows) fail('PART_BINDING_MISMATCH');
  let cursor = startAfter;
  const ordinalMode=payload.rows[0].cursorKey!=null;
  for (const [position,row] of payload.rows.entries()) {
    if (JSON.stringify(safeRow(row,spec)) !== JSON.stringify(row)) fail('PART_PRIVACY_INVALID');
    if((row.cursorKey!=null)!==ordinalMode
      ||ordinalMode&&Number(row.cursorKey)!==processed+position+1)fail('ROW_CURSOR_INVALID');
    // Adapter must use this exact binary/code-point key order, not locale collation.
    const key=row.cursorKey??row.code;
    if (cursor != null && key <= cursor) fail('CURSOR_NOT_ADVANCING');
    cursor = key;
  }
  if (payload.endKey !== cursor) fail('CURSOR_MISMATCH');
  return payload;
}
const partName = index => `part-${String(index).padStart(7,'0')}.json`;

async function privateDirectory(directory) {
  await mkdir(directory,{ recursive:true,mode:0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077)) fail('PRIVATE_DIRECTORY_REQUIRED');
}
async function partAdapter(directory, binding, partsStore) {
  if (partsStore) {
    if (partsStore.binding !== binding || typeof partsStore.readJson !== 'function'
      || typeof partsStore.putJsonOnce !== 'function' || typeof partsStore.initialize !== 'function') fail('PARTS_STORE_BINDING_INVALID');
    await partsStore.initialize();
    return partsStore;
  }
  return {readJson:name=>jsonIfPresent(join(directory,name)),putJsonOnce:(name,value)=>putOnce(join(directory,name),value)};
}

export async function preparePriceExport({ input, directory, partsStore, fetchPage, progress = () => {}, afterPart }) {
  const spec = exportSpec(input), binding = exportBinding(input);
  await privateDirectory(directory);
  const store = await partAdapter(directory,binding,partsStore);
  await store.putJsonOnce('identity.json',{ binding,spec });
  const parts = []; let processed = 0, cursor = null, index = 0, fetched = 0, reused = 0;
  while (processed < spec.expectedRows) {
    if (index === MAX_PARTS) fail('PARTITION_BUDGET_EXCEEDED');
    index++;
    const name = partName(index);
    let record = await store.readJson(name);
    if (!record) {
      const page = await fetchPage({ spec,binding,after:cursor,limit:Math.min(spec.pageSize,spec.expectedRows-processed) });
      if (!page || page.binding !== binding || page.expectedRows !== spec.expectedRows || !Array.isArray(page.rows)
        || !page.rows.length || page.rows.length > spec.pageSize) fail('SOURCE_BINDING_OR_COUNT_INVALID');
      const rows = page.rows.map(row => safeRow(row,spec)), last=rows.at(-1),endKey = last.cursorKey??last.code;
      const complete = processed + rows.length === spec.expectedRows;
      if (typeof page.done !== 'boolean' || page.done !== complete || page.nextCursor !== (complete ? null : endKey)) fail('SOURCE_CURSOR_OR_END_INVALID');
      const payload = { binding,index,ordinalStart:processed+1,startAfter:cursor,endKey,rows };
      record = { payload,sha256:hash(JSON.stringify(payload)) };
      validatePart(record,{spec,binding,index,startAfter:cursor,processed});
      await store.putJsonOnce(name,record); fetched++;
    } else reused++;
    const part = validatePart(record,{spec,binding,index,startAfter:cursor,processed});
    processed += part.rows.length; cursor = part.endKey;
    parts.push({ index,rows:part.rows.length,sha256:record.sha256,endKey:cursor });
    await progress({ stage:'partitioning',processedRows:processed,totalRows:spec.expectedRows,percent:Math.round(processed/spec.expectedRows*10000)/100,fetched,reused });
    if (afterPart) await afterPart({ index,processed,binding });
  }
  const manifest = { binding,spec,rows:processed,parts };
  await store.putJsonOnce('manifest.json',manifest);
  return { manifest,fetched,reused };
}

export async function assemblePriceExport({ input,directory,partsStore,progress = () => {}, afterPartition }) {
  const spec = exportSpec(input), binding = exportBinding(input);
  await privateDirectory(directory);
  const store = await partAdapter(directory,binding,partsStore);
  const identity = await store.readJson('identity.json');
  if (identity?.binding !== binding || JSON.stringify(identity.spec) !== JSON.stringify(spec)) fail('JOB_BINDING_MISMATCH');
  const manifest = await store.readJson('manifest.json');
  if (manifest?.binding !== binding || JSON.stringify(manifest.spec) !== JSON.stringify(spec)
    || manifest.rows !== spec.expectedRows || !Array.isArray(manifest.parts) || !manifest.parts.length) fail('MANIFEST_INVALID');
  if (manifest.parts.length > MAX_PARTS) fail('PARTITION_BUDGET_EXCEEDED');
  const readyPath = join(directory,'ready.json'), ready = await jsonIfPresent(readyPath);
  if (ready) {
    if (ready.binding !== binding || ready.rows !== spec.expectedRows || !/^[a-f0-9-]+\.xlsx$/.test(ready.file)) fail('READY_BINDING_INVALID');
    const actual = await fileHash(join(directory,ready.file));
    if (actual.sha256 !== ready.sha256 || actual.bytes !== ready.bytes) fail('READY_FILE_CHECKSUM_MISMATCH');
    return { ...ready,replayed:true };
  }
  const file = `${randomUUID()}.xlsx`, path = join(directory,file);
  const output = createWriteStream(path,{flags:'wx',mode:0o600});
  const writer = new DeterministicWorkbookWriter({ stream:output,useStyles:true,useSharedStrings:false,zip:{zlib:{level:6}} });
  let writerError;
  output.on('error',error => { writerError = error; });
  let sheet, sheetRows = 0, sheets = 0, processed = 0, cursor = null;
  function newSheet() {
    sheet = writer.addWorksheet(`Price List ${++sheets}`,{views:[{state:'frozen',ySplit:1}]});
    sheet.columns = [{width:24,style:{numFmt:'@'}},{width:58},{width:18,style:{numFmt:'0.00####'}},{width:16,style:{numFmt:'@'}},{width:34}];
    const header = sheet.addRow(['Part_No','Description',`Price_${spec.currency}`,'Price_Date','Lifecycle']);
    header.font = {name:'Arial',size:11,bold:true,color:{argb:'FFFFFFFF'}};
    header.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF142238'}}; header.commit(); sheetRows = 0;
  }
  try {
    newSheet();
    for (let i = 0; i < manifest.parts.length; i++) {
      const record = await store.readJson(partName(i+1));
      const part = validatePart(record,{ spec,binding,index:i+1,startAfter:cursor,processed });
      const entry = { index:i+1,rows:part.rows.length,sha256:record.sha256,endKey:part.endKey };
      if (JSON.stringify(entry) !== JSON.stringify(manifest.parts[i])) fail('MANIFEST_PART_MISMATCH');
      for (const row of part.rows) {
        if (sheetRows === spec.sheetRows) { sheet.autoFilter=`A1:E${sheetRows+1}`; sheet.commit(); newSheet(); }
        sheet.addRow([row.code,row.description,Number(row.price),row.priceDate,
          row.discontinued ? `Discontinued${row.replacementCode ? '; replacement: '+row.replacementCode : ''}` : 'Active']).commit();
        sheetRows++; processed++;
        if (processed % 100 === 0) { await yieldEventLoop(); if (writerError) throw writerError; }
      }
      cursor = part.endKey;
      await progress({stage:'assembling',processedRows:processed,totalRows:spec.expectedRows,percent:Math.round(processed/spec.expectedRows*10000)/100});
      if (afterPartition) await afterPartition({index:i+1,processed});
    }
    if (processed !== spec.expectedRows) fail('FINAL_COUNT_MISMATCH');
    sheet.autoFilter=`A1:E${sheetRows+1}`; sheet.commit(); await writer.commit();
    if (writerError) throw writerError;
    const completedFile = await open(path,'r');
    try { await completedFile.sync(); } finally { await completedFile.close(); }
    const receipt = {binding,rows:processed,sheets,file,...await fileHash(path)};
    if (!receipt.bytes) fail('EMPTY_FILE');
    await putOnce(readyPath,receipt);
    await progress({stage:'ready',processedRows:processed,totalRows:spec.expectedRows,percent:100});
    return {...receipt,replayed:false};
  } catch(error) {
    // Incomplete ZIP kept private, never referenced by ready.json. Restart uses a
    // NEW assembly file; no overwrite/delete of a previous successful artifact.
    writer.zip.abort(); output.destroy(); throw error;
  }
}
