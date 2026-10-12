import { buildWorkbookBytes, type ExportRows, type WorkbookOptions } from "./xlsxCore";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

export async function downloadUrl(name: string, url: string, fallbackUrl?: string) {
  const signed = new URL(url, window.location.href);
  if (signed.protocol === "https:" && signed.pathname.includes("/storage/v1/object/sign/") && !signed.username && !signed.password) {
    // Let the browser download manager stream from Storage: do not buffer the
    // entire large artifact in tab memory or proxy it through Netlify.
    const link = document.createElement("a");
    link.href = signed.href; link.download = name; link.rel = "noopener noreferrer";
    document.body.appendChild(link); link.click(); link.remove();
    return; // Download initiated, not proof the remote transfer finished.
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
