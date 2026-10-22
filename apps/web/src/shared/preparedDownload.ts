// A completed fetch is not proof that the browser accepted a download.
// Keep one explicit, user-clickable save link for the already verified file.
const RETAIN_MS = 5 * 60_000;
const HANDOFF_MS = 30_000;

type SaveWritable = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};
type SavePicker = (options: { suggestedName: string; id: string }) => Promise<{
  createWritable(): Promise<SaveWritable>;
}>;

type PreparedDownload = {
  panel: HTMLElement;
  url: string;
  lastHandoff: number | null;
  expiry: number;
};

let current: PreparedDownload | null = null;
let generation = 0;
const retained = new Map<string, number>();
let lifecycleWindow: Window | null = null;

export function preparedDownloadGeneration() { return generation; }
export function assertPreparedDownloadGeneration(expected: number) {
  if (expected !== generation) throw new Error("Your session changed. Start a new download.");
}

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
  generation += 1;
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
  const remaining = file.lastHandoff !== null ? Math.max(0, file.lastHandoff + HANDOFF_MS - Date.now()) : 0;
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
  const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  const initialHint = typeof picker === "function"
    ? (turkish ? "Kayıt yerini seçerek dosyayı kaydedin. Dosya 5 dakika kullanılabilir."
      : "Choose where to save your file. The file is available for 5 minutes.")
    : (turkish
      ? "Kayıt yerini tarayıcı ayarınız belirler. Safari: Ayarlar → Genel → Dosya indirme konumu → Her indirmede sor. Firefox: Ayarlar → Dosyalar → Dosyaların nereye kaydedileceğini her zaman sor. Ardından Dosyayı kaydet’e basın."
      : "Your browser controls the save location. Safari: Settings → General → File download location → Ask for each download. Firefox: Settings → Files → Always ask you where to save files. Then select Save file.");
  hint.textContent = initialHint;
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
  link.textContent = turkish ? "Dosyayı kaydet" : "Save file";
  Object.assign(link.style, { display: "inline-block", marginTop: "10px", padding: "4px 0", color: "#1d4ed8", textDecoration: "underline" });
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = turkish ? "Kapat" : "Dismiss";
  Object.assign(close.style, { marginLeft: "16px", padding: "6px 10px", cursor: "pointer", color: "#172033", background: "#f1f5f9", border: "1px solid #cbd5e1", borderRadius: "6px" });
  const file: PreparedDownload = { panel, url, lastHandoff: null, expiry: 0 };
  // This is a normal anchor: a later trusted click navigates synchronously,
  // without a fetch, regeneration, preventDefault or another automatic click.
  link.addEventListener("click", () => { file.lastHandoff = Date.now(); });
  close.addEventListener("click", () => { if (current === file) retire(file); });
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = turkish ? "Kaydetme yerini seç" : "Choose save location";
  Object.assign(save.style, { marginTop: "12px", padding: "8px 12px", cursor: "pointer", color: "white", background: "#1d4ed8", border: "0", borderRadius: "6px" });
  const fileGeneration = generation;
  save.addEventListener("click", async () => {
    if (!picker || save.disabled) return;
    save.disabled = true;
    let writable: SaveWritable | undefined;
    try {
      // Invoke directly in the trusted click, before any asynchronous work.
      const handle = await picker.call(window, { suggestedName: name, id: "next-master-download" });
      assertPreparedDownloadGeneration(fileGeneration);
      if (current !== file) throw new Error("File is no longer available.");
      writable = await handle.createWritable();
      assertPreparedDownloadGeneration(fileGeneration);
      if (current !== file) throw new Error("File is no longer available.");
      await writable.write(blob);
      assertPreparedDownloadGeneration(fileGeneration);
      if (current !== file) throw new Error("File is no longer available.");
      await writable.close();
      writable = undefined;
      hint.textContent = turkish ? "Dosya seçtiğiniz konuma kaydedildi." : "File saved to your chosen location.";
    } catch (error) {
      await writable?.abort().catch(() => {});
      if (current !== file || generation !== fileGeneration) return;
      hint.textContent = error instanceof Error && error.name === "AbortError"
        ? (turkish ? "Kaydetme iptal edildi. Tekrar kayıt yeri seçebilirsiniz." : "Save cancelled. You can choose a location again.")
        : (turkish ? "Dosya kaydedilemedi. Tekrar deneyin veya tarayıcı ayarlarında her indirmede kayıt yerini sormayı açıp Dosyayı kaydet’i kullanın."
          : "The file could not be saved. Retry, or enable asking where to save downloads in your browser and use Save file.");
      if (!(error instanceof Error && error.name === "AbortError")) {
        link.hidden = false;
        link.style.display = "inline-block";
      }
    } finally {
      save.disabled = false;
    }
  });
  link.hidden = typeof picker === "function";
  link.style.display = link.hidden ? "none" : "inline-block";
  panel.append(title, filename, hint, ...(typeof picker === "function" ? [save] : []), link, close);
  (document.querySelector?.("dialog[open]") || document.body).appendChild(panel);
  current = file;
  file.expiry = window.setTimeout(() => { if (current === file) retire(file); }, RETAIN_MS);
}
