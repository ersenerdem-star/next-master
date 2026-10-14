// A completed fetch is not proof that the browser accepted a download.
// Keep one explicit, user-clickable save link for the already verified file.
const RETAIN_MS = 5 * 60_000;
const HANDOFF_MS = 30_000;

type PreparedDownload = {
  panel: HTMLElement;
  url: string;
  lastHandoff: number;
  expiry: number;
};

let current: PreparedDownload | null = null;
const retained = new Map<string, number>();
let lifecycleWindow: Window | null = null;

function release(url: string) {
  if (!retained.has(url)) return;
  window.clearTimeout(retained.get(url));
  retained.delete(url);
  URL.revokeObjectURL(url);
  if (!retained.size && lifecycleWindow) {
    lifecycleWindow.removeEventListener("pagehide", clearPreparedDownloads);
    lifecycleWindow = null;
  }
}

// Session end/navigation invalidates every retained link immediately.
export function clearPreparedDownloads() {
  if (current) {
    window.clearTimeout(current.expiry);
    current.panel.remove();
    current = null;
  }
  for (const url of [...retained.keys()]) release(url);
}

function retire(file: PreparedDownload) {
  window.clearTimeout(file.expiry);
  file.panel.remove();
  if (current === file) current = null;
  // Dismissal/replacement must not invalidate a download that just started.
  const remaining = Math.max(0, file.lastHandoff + HANDOFF_MS - Date.now());
  if (remaining) retained.set(file.url, window.setTimeout(() => release(file.url), remaining));
  else release(file.url);
}

export function dismissPreparedDownload() {
  if (current) retire(current);
}

export function offerPreparedDownload(name: string, blob: Blob) {
  dismissPreparedDownload();
  const turkish = document.documentElement.lang.toLowerCase().startsWith("tr");
  const panel = document.createElement("section");
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  panel.setAttribute("aria-atomic", "true");
  panel.setAttribute("data-prepared-download", "");
  Object.assign(panel.style, {
    position: "fixed", bottom: "20px", right: "20px", zIndex: "10000",
    width: "380px", maxWidth: "calc(100vw - 40px)", boxSizing: "border-box",
    padding: "16px", borderRadius: "12px", border: "1px solid #cbd5e1",
    background: "#ffffff", color: "#172033", boxShadow: "0 8px 30px #00000024",
    fontSize: "14px", lineHeight: "1.5", overflowWrap: "anywhere",
  });
  const title = document.createElement("strong");
  title.textContent = turkish ? "Dosya hazır" : "File ready";
  const filename = document.createElement("div");
  filename.textContent = name;
  const hint = document.createElement("div");
  hint.textContent = turkish
    ? "İndirme başlamadıysa aşağıdaki bağlantıyı kullanın. Dosya 5 dakika kullanılabilir."
    : "If your download did not start, use the link below. The file is available for 5 minutes.";
  hint.style.marginTop = "8px";
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  retained.set(url, 0);
  if (!lifecycleWindow) {
    lifecycleWindow = window;
    window.addEventListener("pagehide", clearPreparedDownloads);
  }
  link.href = url;
  link.download = name;
  link.textContent = turkish ? "İndirme başlamadıysa indir" : "Download again";
  Object.assign(link.style, { display: "inline-block", marginTop: "10px", padding: "4px 0", color: "#1d4ed8", textDecoration: "underline" });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = turkish ? "Kapat" : "Dismiss";
  Object.assign(close.style, { marginLeft: "16px", padding: "6px 10px", cursor: "pointer", color: "#172033", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "6px" });
  const file: PreparedDownload = { panel, url, lastHandoff: Date.now(), expiry: 0 };
  // This is a normal anchor: a later trusted click navigates synchronously,
  // without a fetch, regeneration, preventDefault or another automatic click.
  link.addEventListener("click", () => { file.lastHandoff = Date.now(); });
  close.addEventListener("click", () => { if (current === file) retire(file); });
  panel.append(title, filename, hint, link, close);
  document.body.appendChild(panel);
  current = file;
  file.expiry = window.setTimeout(() => { if (current === file) retire(file); }, RETAIN_MS);
  link.click();
}
