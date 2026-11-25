import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n/I18nProvider";
import { preparePortalOrderLines, type PortalPreparedLine } from "../../../infrastructure/api/portalOrderApi";
import { Button } from "../../../presentation/components/common/Button";
import { parseOrderImportFile } from "../../../shared/orderImport";
import type { PortalCredentials } from "../../../types/portalSession";
import { priceExcelPreview } from "../portalExcelPricePreview";

type Props = { inviteId: string; credentials: PortalCredentials; currency: string; fallbackBrand: string; online: boolean };

export function PortalExcelPricePreview({ inviteId, credentials, currency, fallbackBrand, online }: Props) {
  const { locale } = useI18n();
  const tr = locale === "tr";
  const input = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [lines, setLines] = useState<PortalPreparedLine[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [resultCurrency, setResultCurrency] = useState("");

  useEffect(() => () => { activeRequest.current?.abort(); }, []);

  async function inspect(file: File) {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLines(null);
    setResultCurrency("");
    setError("");
    setProgress(tr ? "Dosya okunuyor…" : "Reading file…");
    setFileName(file.name);
    setLoading(true);
    try {
      if (!online) throw new Error(tr ? "Fiyat sorgulamak için internete bağlanın." : "Connect to the internet to look up prices.");
      const rows = await parseOrderImportFile(file, fallbackBrand);
      if (controller.signal.aborted) return;
      const result = await priceExcelPreview(rows,
        (chunk, signal) => preparePortalOrderLines(credentials, chunk, { signal, expectedInviteId: inviteId }), controller.signal,
        (processed, total) => setProgress(tr ? `${processed} / ${total} satır sorgulandı.` : `${processed} / ${total} rows checked.`));
      if (!controller.signal.aborted) { setLines(result.lines); setResultCurrency(result.currency); }
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : (tr ? "Fiyat sorgusu tamamlanamadı." : "Price lookup failed."));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setLoading(false);
        if (input.current) input.current.value = "";
      }
    }
  }

  return <section className="portal-excel-price-preview" aria-label={tr ? "Excel ile fiyat sorgula" : "Check prices with Excel"}>
    <input ref={input} type="file" hidden accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm" onChange={(event) => { const file = event.target.files?.[0]; if (file) void inspect(file); }} />
    <div className="portal-excel-price-preview__heading">
      <div><strong>{tr ? "Excel ile fiyat sorgula" : "Check prices with Excel"}</strong><p>{tr ? "Dosyadaki ürünleri ve size özel fiyatları önizleyin. Sipariş oluşturulmaz veya değiştirilmez." : "Preview products and your prices. No order is created or changed."}</p></div>
      <Button type="button" variant="secondary" disabled={loading} onClick={() => input.current?.click()}>{tr ? "Dosya seç ve fiyatları sorgula" : "Choose file and check prices"}</Button>
    </div>
    {loading ? <p role="status">{progress}</p> : null}
    {error ? <p role="alert">{tr ? "Fiyat sorgusu tamamlanamadı: " : "Price lookup failed: "}{error}</p> : null}
    {lines ? <div className="portal-excel-price-preview__results" aria-live="polite">
      <p>{tr ? `${fileName} · ${lines.length} sonuç` : `${fileName} · ${lines.length} results`}</p>
      {lines.length ? <div className="portal-excel-price-preview__scroll"><table>
        <thead><tr><th>{tr ? "Parça no" : "Part number"}</th><th>{tr ? "Marka" : "Brand"}</th><th>{tr ? "Açıklama / durum" : "Description / status"}</th><th>{tr ? "Adet" : "Qty"}</th><th>{tr ? "Birim fiyat" : "Unit price"}</th></tr></thead>
        <tbody>{lines.map((line, index) => <tr key={`${line.lineId}-${index}`}><td>{line.requestedCode || line.resolvedCode}{line.requestedCode && line.resolvedCode && line.requestedCode !== line.resolvedCode ? <div>{tr ? "Değişen no: " : "Replacement: "}{line.resolvedCode}</div> : null}</td><td>{line.brand}</td><td>{line.description || "–"}{line.lifecycle_status === "discontinued" ? <div>{tr ? "Üretimi bitmiş" : "Discontinued"}</div> : null}{line.quantity_adjusted ? <div>{line.quantity_adjustment_note || (tr ? "Adet tedarikçi şartlarına göre düzenlendi." : "Quantity adjusted to supplier conditions.")}</div> : null}</td><td>{line.qty}</td><td>{line.sell_price == null ? (tr ? "Fiyat bulunamadı" : "Price unavailable") : `${Number(line.sell_price).toLocaleString(tr ? "tr-TR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${resultCurrency || currency}`}</td></tr>)}</tbody>
      </table></div> : <p>{tr ? "Fiyat sonucu bulunamadı." : "No price results found."}</p>}
    </div> : null}
  </section>;
}
