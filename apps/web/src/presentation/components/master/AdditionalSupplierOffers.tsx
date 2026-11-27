import { useEffect, useId, useRef, useState } from "react";
import { fetchSupplierComparisonOffers, type SupplierComparisonOffer } from "../../../infrastructure/api/supplierComparisonOffersApi";
import { useI18n } from "../../../i18n/I18nProvider";
import type { MasterRow } from "../../../types/master";
import { MoneyCell } from "./MasterIntelligenceComponents";

type Status = "idle" | "loading" | "loaded" | "error";

/** Hide the two offers already displayed only when the current values match. */
export function additionalOffers(offers: SupplierComparisonOffer[], row: MasterRow) {
  const normalize = (value: string | null) => String(value || "").trim().toLocaleLowerCase("en-US");
  const matches = (offer: SupplierComparisonOffer | undefined, name: string | null, price: number | null) =>
    offer != null && price != null && normalize(offer.supplier_name) === normalize(name)
      && Math.abs(offer.buy_price - Number(price)) < 0.000001;
  const hasSecond = Boolean(row.second_supplier_name && row.second_price != null);
  const hasFirst = Boolean(row.cheapest_supplier && row.cheapest_price != null);
  const changed = (hasFirst ? !matches(offers[0], row.cheapest_supplier, row.cheapest_price) : offers.length > 0)
    || (hasSecond && !matches(offers[1], row.second_supplier_name, row.second_price));
  return { changed, offers: changed ? offers : offers.slice(hasSecond ? 2 : hasFirst ? 1 : 0) };
}

export function AdditionalSupplierOffers({ brandId, row }: { brandId: string; row: MasterRow }) {
  const { locale } = useI18n();
  const tr = locale === "tr";
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [offers, setOffers] = useState<SupplierComparisonOffer[]>([]);
  const requestId = useRef(0);
  const panelId = useId();

  useEffect(() => () => { requestId.current += 1; }, []);

  async function load() {
    const request = ++requestId.current;
    setStatus("loading");
    try {
      const result = await fetchSupplierComparisonOffers({ brandId, productCode: row.product_code });
      if (request !== requestId.current) return;
      setOffers(result);
      setStatus("loaded");
    } catch {
      if (request === requestId.current) setStatus("error");
    }
  }

  function toggle() {
    if (open) { requestId.current += 1; setOpen(false); return; }
    setOpen(true);
    void load();
  }

  const extraCount = row.supplier_count == null ? null : Math.max(0, Number(row.supplier_count) - 2);
  if (!brandId || !row.product_code) return null;
  const result = status === "loaded" ? additionalOffers(offers, row) : null;

  return (
    <div className="additional-supplier-offers">
      <button type="button" className="additional-supplier-offers__toggle" aria-expanded={open} aria-controls={panelId}
        aria-label={`${row.product_code}: ${open ? (tr ? "tedarikçileri kapat" : "hide suppliers") : (tr ? "güncel tedarikçileri gör" : "show current suppliers")}`} onClick={toggle}>
        {open ? (tr ? "Tedarikçileri kapat" : "Hide suppliers") : extraCount != null && extraCount > 0
          ? (tr ? "Diğer tedarikçileri gör" : "Show other suppliers")
          : (tr ? "Güncel tedarikçileri kontrol et" : "Check current suppliers")}
        {!open && extraCount != null && extraCount > 0 ? ` (+${extraCount})` : ""}
      </button>
      {open ? <div id={panelId} className="additional-supplier-offers__panel">
        {status === "loading" ? <span role="status">{tr ? "Tedarikçi fiyatları yükleniyor…" : "Loading supplier prices…"}</span> : null}
        {status === "error" ? <div role="alert">
          <span>{tr ? "Tedarikçi fiyatları yüklenemedi." : "Could not load supplier prices."}</span>{" "}
          <button type="button" onClick={() => void load()}>{tr ? "Tekrar dene" : "Try again"}</button>
        </div> : null}
        {result?.changed ? <p className="additional-supplier-offers__notice">{tr ? "Tablodaki fiyatlar değişmiş olabilir; güncel tekliflerin tümü gösteriliyor." : "The table prices may have changed; all current offers are shown."}</p> : null}
        {result && !result.offers.length ? <span>{result.changed
          ? tr ? "Güncel tedarikçi bulunamadı." : "No current suppliers found."
          : tr ? "Başka güncel tedarikçi bulunamadı." : "No other current suppliers found."}</span> : null}
        {result?.offers.length ? <ul className="additional-supplier-offers__list">
          {result.offers.map((offer, index) => <li key={`${offer.supplier_id}-${index}`}>
            <span className="additional-supplier-offers__primary"><strong>{offer.supplier_name}</strong><MoneyCell value={offer.buy_price} /></span>
            <span className="additional-supplier-offers__terms">
              {offer.price_date ? <span>{tr ? "Fiyat tarihi" : "Price date"}: {offer.price_date}</span> : null}
              {offer.moq != null ? <span>MOQ: {offer.moq}</span> : null}
              {offer.order_multiple != null && offer.order_multiple > 1 ? <span>{tr ? "Sipariş katı" : "Order multiple"}: {offer.order_multiple}</span> : null}
              {offer.stock_qty != null ? <span>{tr ? "Tedarikçi stoku" : "Supplier stock"}: {offer.stock_qty}</span> : null}
              {offer.valid_to ? <span>{tr ? "Geçerli son tarih" : "Valid until"}: {offer.valid_to}</span> : null}
              {offer.notes ? <span>{offer.notes}</span> : null}
            </span>
          </li>)}
        </ul> : null}
      </div> : null}
    </div>
  );
}
