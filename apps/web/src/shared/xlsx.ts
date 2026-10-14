import { buildWorkbookBytes, type ExportRows, type WorkbookOptions } from "./xlsxCore";
import { offerPreparedDownload } from "./preparedDownload";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_TYPE = "text/csv;charset=utf-8";
// Verified admin and portal downloads must fit in browser memory.
// The current million-row workbook is about 25 MB; larger exports need a
// streaming-to-disk transport instead of an unbounded Blob allocation.
const MAX_EXPORT_DOWNLOAD_BYTES = 128 * 1024 * 1024;

export type ExportDownloadPart = { signedUrl: string; byteSize: number };

export function buildXlsxBlob(sheetName: string, rows: ExportRows, numericColumns: number[] = [], options: WorkbookOptions = {}) {
  return new Blob([buildWorkbookBytes(sheetName, rows, numericColumns, options)], { type: XLSX_TYPE });
}

export async function buildXlsxBlobAsync(sheetName: string, rows: ExportRows, numericColumns: number[] = [], options: WorkbookOptions = {}) {
  if (typeof Worker === "undefined") return buildXlsxBlob(sheetName, rows, numericColumns, options);
  const worker = new Worker(new URL("./xlsx.worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error("Excel preparation timed out. No file was downloaded.")); }, 120_000);
      const finish = () => clearTimeout(timer);
      worker.onmessage = ({ data }) => { finish(); data.error ? reject(new Error(data.error)) : resolve(new Blob([data.buffer], { type: XLSX_TYPE })); };
      worker.onerror = () => { finish(); reject(new Error("Excel worker failed. No file was downloaded.")); };
      worker.postMessage({ sheetName, rows, numericColumns, options });
    });
  } finally { worker.terminate(); }
}

export function downloadBlob(name: string, blob: Blob) {
  offerPreparedDownload(name, blob);
}

function signedStorageTarget(signedUrl: string) {
  const target = new URL(signedUrl, window.location.href);
  if (target.protocol !== "https:" || !target.pathname.includes("/storage/v1/object/sign/")
    || target.username || target.password || target.hash) {
    throw new Error("Export download link is invalid.");
  }
  return target;
}

async function fetchSignedStorageChunks(target: URL, expectedByteSize?: number) {
  // A Netlify function cannot stream a workbook above its 20 MB response
  // limit. Supabase Storage permits CORS reads of this short-lived signed URL.
  // Fetching it avoids Chrome extensions blocking anchor navigation while
  // keeping the file off the application function's response path.
  const response = await fetch(target.href, {
    credentials: "omit", cache: "no-store", redirect: "error", mode: "cors",
  });
  if (!response.ok) throw new Error(`Export download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("Export download returned no file content.");

  const requestedBytes = Number.isSafeInteger(expectedByteSize) && Number(expectedByteSize) > 0
    ? Number(expectedByteSize) : 0;
  const headerValue = response.headers.get("Content-Length");
  const headerBytes = headerValue === null ? 0 : Number(headerValue);
  if (headerValue !== null && (!Number.isSafeInteger(headerBytes) || headerBytes < 0)) {
    throw new Error("Export download returned an invalid file size.");
  }
  if (requestedBytes && headerBytes && requestedBytes !== headerBytes) {
    throw new Error("Export download size differs from the export job.");
  }
  const expectedBytes = requestedBytes || headerBytes;
  if (expectedBytes > MAX_EXPORT_DOWNLOAD_BYTES) {
    throw new Error("Export is too large for browser download.");
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let receivedBytes = 0;
  const maxBytes = expectedBytes || MAX_EXPORT_DOWNLOAD_BYTES;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) throw new Error("Export download exceeded the expected file size.");
      // Fetch streams provide ArrayBuffer-backed byte chunks in browsers.
      // Keep those chunks without another full-workbook copy.
      chunks.push(value as Uint8Array<ArrayBuffer>);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (expectedBytes && receivedBytes !== expectedBytes) {
    throw new Error(`Export download was incomplete (${receivedBytes} of ${expectedBytes} bytes).`);
  }
  return { chunks, receivedBytes };
}

async function downloadSignedStorageUrl(name: string, signedUrl: string, expectedByteSize?: number, parts?: ExportDownloadPart[]) {
  const target = signedStorageTarget(signedUrl);
  const chunks: BlobPart[] = [];
  let receivedBytes = 0;
  if (parts !== undefined) {
    if (!Array.isArray(parts) || parts.length < 2) throw new Error("Export download parts are invalid.");
    const urls = new Set<string>();
    let totalBytes = 0;
    const targets = parts.map((part) => {
      if (!part || typeof part.signedUrl !== "string" || !Number.isSafeInteger(part.byteSize) || part.byteSize <= 0) {
        throw new Error("Export download parts are invalid.");
      }
      const partTarget = signedStorageTarget(part.signedUrl);
      if (partTarget.origin !== target.origin || urls.has(partTarget.href)) throw new Error("Export download parts are invalid.");
      urls.add(partTarget.href);
      totalBytes += part.byteSize;
      return partTarget;
    });
    if (targets[0].href !== target.href || !Number.isSafeInteger(totalBytes) || totalBytes !== expectedByteSize) {
      throw new Error("Export download parts do not match the complete file size.");
    }
    if (totalBytes > MAX_EXPORT_DOWNLOAD_BYTES) throw new Error("Export is too large for browser download.");
    for (let index = 0; index < parts.length; index += 1) {
      const result = await fetchSignedStorageChunks(targets[index], parts[index].byteSize);
      for (const chunk of result.chunks) chunks.push(chunk);
      receivedBytes += result.receivedBytes;
    }
    if (receivedBytes !== totalBytes) throw new Error("Export download was incomplete.");
  } else {
    const result = await fetchSignedStorageChunks(target, expectedByteSize);
    for (const chunk of result.chunks) chunks.push(chunk);
    receivedBytes = result.receivedBytes;
  }
  const blob = new Blob(chunks, { type: /\.csv$/i.test(name) ? CSV_TYPE : XLSX_TYPE });
  if (blob.size !== receivedBytes || blob.size < 1) {
    throw new Error("Export download returned an invalid file.");
  }
  if (/\.xlsx?$/i.test(name)) {
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
      throw new Error("Export download returned an invalid workbook.");
    }
  }
  downloadBlob(name, blob);
}

export async function downloadUrl(name: string, url: string, fallbackUrl?: string, expectedByteSize?: number, parts?: ExportDownloadPart[]) {
  const signed = new URL(url, window.location.href);
  if (parts !== undefined || (signed.protocol === "https:" && signed.pathname.includes("/storage/v1/object/sign/")
    && !signed.username && !signed.password)) {
    // Portal and admin exports both carry a short-lived signed Storage URL.
    // Verify the complete workbook before reporting that download began so a
    // browser extension or partial transfer cannot be mistaken for success.
    await downloadSignedStorageUrl(name, url, expectedByteSize, parts);
    return;
  }
  let lastError: unknown = null;
  for (const target of [url, fallbackUrl].filter((value): value is string => Boolean(String(value || "").trim()))) {
    try {
      const response = await fetch(target, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      downloadBlob(name, await response.blob());
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Download failed.");
}
