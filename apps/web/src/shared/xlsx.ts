import { buildWorkbookBytes, type ExportRows, type WorkbookOptions } from "./xlsxCore";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// The portal's authenticated same-origin download must fit in browser memory.
// Its current million-row workbook is about 25 MB; larger exports need a
// streaming-to-disk transport instead of an unbounded Blob allocation.
const MAX_PORTAL_DOWNLOAD_BYTES = 128 * 1024 * 1024;

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
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Keep the object URL alive while the browser hands a large workbook to its
  // download manager. Revoking it immediately can race that handoff.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function downloadPortalUrl(name: string, signedUrl: string, expectedByteSize?: number) {
  const target = new URL(signedUrl, window.location.href);
  if (target.protocol !== "https:" || !target.pathname.includes("/storage/v1/object/sign/")
    || target.username || target.password || target.hash) {
    throw new Error("Portal download link is invalid.");
  }
  // A Netlify function cannot stream a workbook above its 20 MB response
  // limit. Supabase Storage permits CORS reads of this short-lived signed URL.
  // Fetching it avoids Chrome extensions blocking anchor navigation while
  // keeping the file off the application function's response path.
  const response = await fetch(target.href, {
    credentials: "omit", cache: "no-store", redirect: "error", mode: "cors",
  });
  if (!response.ok) throw new Error(`Portal download failed: HTTP ${response.status}`);
  if (!response.body) throw new Error("Portal download returned no file content.");

  const requestedBytes = Number.isSafeInteger(expectedByteSize) && Number(expectedByteSize) > 0
    ? Number(expectedByteSize) : 0;
  const headerValue = response.headers.get("Content-Length");
  const headerBytes = headerValue === null ? 0 : Number(headerValue);
  if (headerValue !== null && (!Number.isSafeInteger(headerBytes) || headerBytes < 0)) {
    throw new Error("Portal download returned an invalid file size.");
  }
  if (requestedBytes && headerBytes && requestedBytes !== headerBytes) {
    throw new Error("Portal download size differs from the export job.");
  }
  const expectedBytes = requestedBytes || headerBytes;
  if (expectedBytes > MAX_PORTAL_DOWNLOAD_BYTES) {
    throw new Error("Portal export is too large for browser download.");
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let receivedBytes = 0;
  const maxBytes = expectedBytes || MAX_PORTAL_DOWNLOAD_BYTES;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) throw new Error("Portal download exceeded the expected file size.");
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
    throw new Error(`Portal download was incomplete (${receivedBytes} of ${expectedBytes} bytes).`);
  }
  const blob = new Blob(chunks, { type: XLSX_TYPE });
  if (blob.size !== receivedBytes || blob.size < 1) {
    throw new Error("Portal download returned an invalid workbook.");
  }
  if (/\.xlsx?$/i.test(name)) {
    const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) {
      throw new Error("Portal download returned an invalid workbook.");
    }
  }
  downloadBlob(name, blob);
}

export async function downloadUrl(name: string, url: string, fallbackUrl?: string, expectedByteSize?: number) {
  const signed = new URL(url, window.location.href);
  if (signed.protocol === "https:" && signed.pathname.includes("/storage/v1/object/sign/")
    && !signed.username && !signed.password) {
    // Portal and admin exports both carry a short-lived signed Storage URL.
    // Verify the complete workbook before reporting that download began so a
    // browser extension or partial transfer cannot be mistaken for success.
    await downloadPortalUrl(name, url, expectedByteSize);
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
