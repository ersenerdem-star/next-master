import {useI18n} from "../../../i18n/I18nProvider";
import {InterfaceText,useInterfaceText} from "../../../i18n/InterfaceText";
import { useEffect, useState, type FormEvent } from "react";
import type { PortalSnapshot } from "../../../types/portalSession";
import { Button } from "../../../presentation/components/common/Button";
import { BrandPill } from "../../../presentation/components/common/BrandPill";
import { ProductVisual } from "../../../presentation/components/common/ProductVisual";
import { VehicleBadges } from "../../../presentation/components/common/VehicleBadges";
import type { PortalCatalogSearchItem, PortalPreparedLine, PortalSearchField } from "../../../infrastructure/api/portalOrderApi";

type PortalSearchResultsProps = {
  initialSearchField?: PortalSearchField;
  results: PortalCatalogSearchItem[];
  query: string;
  brand: string;
  brands: Array<{ value: string; label: string }>;
  snapshot: PortalSnapshot;
  currency: string;
  searching: boolean;
  onQueryChange: (value: string) => void;
  onBrandChange: (value: string) => void;
  onSearch: (searchField: PortalSearchField) => void;
  onClear: () => void;
  onImport: () => void;
  onTemplate: () => void;
  onExport: () => void;
  exportDisabled: boolean;
  basketCount: number;
  orderStatus?: string;
  draftLines: PortalPreparedLine[];
  savingBasket: boolean;
  confirmingBasket: boolean;
  confirmDisabled: boolean;
  orderNotes: string;
  deliveryTerm: string;
  paymentTerms: string;
  packingDetails: string;
  onOrderNotesChange: (value: string) => void;
  onDeliveryTermChange: (value: string) => void;
  onPaymentTermsChange: (value: string) => void;
  onPackingDetailsChange: (value: string) => void;
  onQuantityChange: (lineId: string, quantity: number) => void;
  onSaveBasket: () => void;
  onClearBasket: () => void;
  onConfirmBasket: () => void;
  selectedCode: string;
  onSelect: (item: PortalCatalogSearchItem) => void;
  onAdd: (item: PortalCatalogSearchItem, quantity: number) => void;
  onPreview?: (item: PortalCatalogSearchItem) => void;
};

function formatMoneyForLocale(value: number | null | undefined, currency: string, locale = "en") {
  if (value == null) return "Price on request";
  return `${Number(value).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatDateForLocale(value?: string, locale = "en") {
  if (!value) return "No order history";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function compactText(value: string, maxLength = 68) {
  const text = String(value || "").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function hasProductCode(line: { code?: string; requested_code?: string; old_code?: string } | undefined, code: string) {
  if (!line) return false;
  return [line.code, line.requested_code, line.old_code].some((value) => String(value || "").trim() === code);
}

export function PortalSearchResults({
  initialSearchField="part_number",
  results,
  query,
  brand,
  brands,
  snapshot,
  currency,
  searching,
  onQueryChange,
  onBrandChange,
  onSearch,
  onClear,
  onImport,
  onTemplate,
  onExport,
  exportDisabled,
  basketCount,
  orderStatus,
  draftLines,
  savingBasket,
  confirmingBasket,
  confirmDisabled,
  orderNotes,
  deliveryTerm,
  paymentTerms,
  packingDetails,
  onOrderNotesChange,
  onDeliveryTermChange,
  onPaymentTermsChange,
  onPackingDetailsChange,
  onQuantityChange,
  onSaveBasket,
  onClearBasket,
  onConfirmBasket,
  selectedCode,
  onSelect,
  onAdd,
  onPreview,
}: PortalSearchResultsProps) {
  const ui=useInterfaceText();
  const {locale}=useI18n();
  const formatMoney=(value: number | null | undefined, currency: string)=>ui(formatMoneyForLocale(value,currency,locale));
  const formatDate=(value?:string)=>ui(formatDateForLocale(value,locale));
  const [searchField, setSearchField] = useState<PortalSearchField>(initialSearchField);
  const [addQuantity, setAddQuantity] = useState(1);
  const [showAllResults, setShowAllResults] = useState(false);
  const selected = results.find((item) => item.code === selectedCode) || results[0] || null;
  const visibleResults = showAllResults ? results : results.slice(0, 12);
  useEffect(() => setShowAllResults(false), [query, results.length]);
  const documentRows = snapshot.invite.party_type === "customer" ? snapshot.salesOrders : snapshot.purchaseOrders;
  const matchedOrder = selected
    ? documentRows.find((order) => (order.lines || []).some((line) => hasProductCode(line, selected.code)))
    : null;
  const latestOrder = matchedOrder || documentRows[0] || null;
  const selectedOrderLine = latestOrder?.lines?.find((line) => hasProductCode(line, selected?.code || ""));
  const openInvoice = (snapshot.invite.party_type === "customer" ? snapshot.invoices : snapshot.bills).find(
    (invoice) => !["paid", "settled", "closed"].includes(String(invoice.status || "").toLowerCase()),
  );
  const pricedLines = draftLines.filter((line) => line.sell_price != null);
  const unpricedLines = draftLines.length - pricedLines.length;
  const orderSubtotal = pricedLines.reduce((total, line) => total + Number(line.sell_price || 0) * Number(line.qty || 0), 0);
  const orderQuantity = draftLines.reduce((total, line) => total + Number(line.qty || 0), 0);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(searchField);
  }

  const searchTabs: Array<{ value: PortalSearchField; label: string }> = [
    { value: "part_number", label: ui("Part number") },
    { value: "oem", label: "OEM" },
    { value: "vehicle", label: ui("Vehicle") },
    { value: "description", label: ui("Description") },
  ];

  const searchPlaceholder: Record<PortalSearchField, string> = {
    part_number: "Part number",
    oem: "OEM number",
    vehicle: "Vehicle make, model or engine",
    description: "Part description",
  };

  return (
    <div className="portal-search-result-view">
      <div className="portal-search-result-view__toolbar">
        <div className="portal-search-result-view__types" role="tablist" aria-label={ui("Search type")}>
          {searchTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={searchField === tab.value ? "is-active" : ""}
              aria-selected={searchField === tab.value}
              onClick={() => setSearchField(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <form className="portal-search-result-view__form" onSubmit={submitSearch}>
          <select aria-label={ui("Search brand")} value={brand} onChange={(event) => onBrandChange(event.target.value)}>
            {brands.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
          </select>
          <input aria-label={`${searchTabs.find((tab) => tab.value === searchField)?.label || "Part"} search`} placeholder={searchPlaceholder[searchField]} value={query} onChange={(event) => onQueryChange(event.target.value)} />
          <button type="button" className="portal-search-result-view__clear" onClick={onClear} aria-label={ui("Clear search")}>×</button>
          <button type="submit" className="portal-search-result-view__submit" disabled={searching}>{searching ? "…" : ui("Search")}</button>
        </form>
        <div className="portal-search-result-view__actions" aria-label={ui("Import and export tools")}>
          <div className="portal-search-result-view__action-group">
            <span className="portal-search-result-view__action-label"><InterfaceText text={"Sales order tools"}/></span>
            <Button type="button" variant="secondary" onClick={onImport}>
              <InterfaceText text={"Import Excel"}/></Button>
            <Button type="button" variant="secondary" onClick={onTemplate}>
              <InterfaceText text={"Template"}/></Button>
            <Button type="button" variant="secondary" onClick={onExport} disabled={exportDisabled}>
              <InterfaceText text={"Export sales order"}/></Button>
          </div>
          <div className="portal-search-result-view__action-status" aria-live="polite">
            <strong>{basketCount.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={" sales order line"}/>{basketCount === 1 ? "" : "s"}</strong>
            <span>{orderStatus || ui("Import a file or add a search result to build a sales order.")}</span>
          </div>
        </div>
        <div className="portal-inline-note portal-inline-note--soft portal-inline-note--compact portal-search-result-view__import-limit-note" role="note">
          <span><InterfaceText text={"Price lookup limit"}/></span>
          <strong><InterfaceText text={"Price lookups run in batches of up to 200 rows. Larger files are split automatically; save or send each sales order with 200 lines or fewer."}/></strong>
        </div>
        {basketCount > 200 ? (
          <div className="portal-search-result-view__order-limit-warning" role="alert">
            <InterfaceText text={"This sales order has"}/>{basketCount.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={"lines. Split it into 200-line lists before saving or sending."}/></div>
        ) : null}
      </div>

      <div className="portal-search-result-view__layout">
        <aside className="portal-search-result-rail" aria-label={ui("Search results")}>
          <div className="portal-search-result-rail__summary">
            {results.length.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={" result"}/>{results.length === 1 ? "" : "s"} <InterfaceText text={" for “"}/>{query || ui("all parts")}”
          </div>
          <div className="portal-search-result-rail__items">
            {visibleResults.map((item) => (
              <button
                type="button"
                key={`${item.brand}-${item.code}`}
                className={`portal-search-result-rail__item${selected?.code === item.code ? " is-active" : ""}`}
                onClick={() => onSelect(item)}
              >
                <span className="portal-search-result-rail__media"><ProductVisual imageUrl={item.image_url} brand={item.brand} alt={item.code} /></span>
                <span className="portal-search-result-rail__copy">
                  <strong>{item.code || "-"}</strong>
                  <BrandPill brand={item.brand} compact withLogo className="portal-search-result-rail__brand" />
                  <span>{compactText(item.description || "Part description", 48)}</span>
                  <small>{item.available_qty == null ? ui("Stock check") : ui(`${Number(item.available_qty).toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} in stock`)}</small>
                </span>
                <span className="portal-search-result-rail__chevron">›</span>
              </button>
            ))}
          </div>
          {results.length > 12 ? (
            <button type="button" className="portal-search-result-rail__all" onClick={() => setShowAllResults((current) => !current)}>
              {showAllResults ? ui("Show fewer results") : `View all ${results.length.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} results`}
            </button>
          ) : null}
        </aside>

        <main className="portal-search-result-main">
          {selected ? (
            <>
              <div className="portal-search-result-main__header">
                <div>
                  <span className="portal-search-result-main__eyebrow"><InterfaceText text={"Selected part"}/></span>
                  <h2>{selected.code}</h2>
                  <p>{selected.description || ui("Part description")}</p>
                  <span>{selected.market_segment || "Automotive"}</span>
                </div>
                <BrandPill brand={selected.brand} compact logoOnly />
              </div>
              <div className="portal-search-result-main__hero">
                <div className="portal-search-result-main__image">
                  <ProductVisual
                    imageUrl={selected.image_url}
                    brand={selected.brand}
                    alt={selected.code}
                    detail
                    onPreview={onPreview ? () => onPreview(selected) : null}
                  />
                </div>
                <div className="portal-search-result-main__purchase">
                  <div className="portal-search-result-main__stock"><span />{selected.available_qty == null ? ui("Stock check") : ui(`${Number(selected.available_qty).toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} pcs available`)}</div>
                  <strong className="portal-search-result-main__price">{formatMoney(selected.sell_price, selected.currency || currency)}</strong>
                  <span className="portal-search-result-main__price-note"><InterfaceText text={"Your customer price · Excl. VAT"}/></span>
                  <div className="portal-search-result-main__actions">
                    <label className="portal-search-result-main__quantity">
                      <span><InterfaceText text={"Quantity"}/></span>
                      <input
                        aria-label={ui("Quantity to add")}
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={addQuantity}
                        onChange={(event) => setAddQuantity(Math.max(1, Math.floor(Number(event.target.value || 1) || 1)))}
                      />
                    </label>
                    <Button onClick={() => onAdd(selected, addQuantity)}><InterfaceText text={"Add to sales order"}/></Button>
                  </div>
                  <button type="button" className="portal-search-result-main__secondary" onClick={() => onPreview?.(selected)}><InterfaceText text={"View larger / details"}/></button>
                </div>
              </div>
              {selected.replacement_warning ? (
                <div className="portal-search-result-main__notice"><strong><InterfaceText text={"Replacement note"}/></strong><span>{selected.replacement_warning}</span></div>
              ) : null}
              <div className="portal-search-result-main__facts">
                <section><h3><InterfaceText text={"OEM references"}/></h3><p>{selected.oem_no || ui("No OEM references recorded")}</p><button type="button" onClick={() => onPreview?.(selected)}><InterfaceText text={"Show all references"}/></button></section>
                <section><h3><InterfaceText text={"Vehicle compatibility"}/></h3><div className="portal-search-result-main__vehicle"><VehicleBadges value={selected.vehicle || ""} limit={5} expandable logoOnly /></div><button type="button" onClick={() => onPreview?.(selected)}><InterfaceText text={"View compatible vehicles"}/></button></section>
              </div>
              <div className="portal-search-result-main__metadata">
                <span><InterfaceText text={"Tariff "}/>{selected.tariff || "-"}</span>
                <span><InterfaceText text={"Origin "}/>{selected.origin || "-"}</span>
                <span><InterfaceText text={"Weight "}/>{selected.weight_kg == null ? "-" : `${selected.weight_kg} kg`}</span>
              </div>
            </>
          ) : <div className="empty-state"><InterfaceText text={"Search by part number, OEM, vehicle or description."}/></div>}
        </main>

        <aside className="portal-search-result-insights" aria-label={ui("Account insights")}>
          <section className="portal-search-insight-card">
            <h3><InterfaceText text={"Last ordered"}/></h3>
            <small>{formatDate(latestOrder?.updated_at || latestOrder?.quote_date)}</small>
            <strong>{selected?.code || "-"}</strong>
            <span>{selectedOrderLine?.description || latestOrder?.status || ui("No previous order for this part")}</span>
            {selectedOrderLine?.qty ? <small><InterfaceText text={"Qty: "}/>{selectedOrderLine.qty}</small> : null}
            <button type="button" onClick={() => onPreview?.(selected || results[0])}><InterfaceText text={"View order history ›"}/></button>
          </section>
          <section className="portal-search-insight-card">
            <h3><InterfaceText text={"Price movement "}/><small><InterfaceText text={"(customer price)"}/></small></h3>
            <strong>{selected ? formatMoney(selected.sell_price, selected.currency || currency) : "-"}</strong>
            <span><InterfaceText text={"No prior movement data available yet."}/></span>
            <div className="portal-search-insight-card__line" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
            <button type="button" onClick={() => onPreview?.(selected || results[0])}><InterfaceText text={"View price details ›"}/></button>
          </section>
          <section className="portal-search-insight-card portal-search-insight-card--invoice">
            <h3><InterfaceText text={"Open invoice reminder"}/></h3>
            <strong>{openInvoice ? formatMoney(openInvoice.total_amount, openInvoice.currency || currency) : ui("No open invoice")}</strong>
            <span>{openInvoice ? `Due date: ${formatDate(openInvoice.due_date)}` : ui("Your account is up to date.")}</span>
            <button type="button" onClick={() => onPreview?.(selected || results[0])}><InterfaceText text={"View invoices ›"}/></button>
          </section>
        </aside>
      </div>

      <section className="portal-order-workspace" aria-label={ui("Sales order workspace")}>
        <div className="portal-order-workspace__header">
          <div>
            <span className="portal-search-result-view__eyebrow"><InterfaceText text={"Sales order workspace"}/></span>
            <h3><InterfaceText text={"New sales order"}/></h3>
            <p>{draftLines.length ? ui("Review lines, quantities and customer terms before saving or confirming the order.") : ui("Add a search result or import a file to start an order.")}</p>
          </div>
          <div className="portal-order-workspace__header-meta">
            <span className="portal-order-workspace__status">{ui(orderStatus || "Draft")}</span>
            <strong>{draftLines.length.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={" line"}/>{draftLines.length === 1 ? "" : "s"}</strong>
          </div>
        </div>

        <div className="portal-order-workspace__toolbar" aria-label={ui("Sales order actions")}>
          <div className="portal-order-workspace__toolbar-group">
            <span className="portal-order-workspace__toolbar-label"><InterfaceText text={"Order actions"}/></span>
            <Button variant="secondary" busy={savingBasket} busyLabel="Saving..." onClick={onSaveBasket} disabled={!draftLines.length}><InterfaceText text={"Save sales order → Documents / Orders"}/></Button>
            <Button variant="secondary" onClick={onClearBasket} disabled={!draftLines.length}><InterfaceText text={"Clear lines"}/></Button>
            <Button busy={confirmingBasket} busyLabel="Confirming..." onClick={onConfirmBasket} disabled={!draftLines.length || confirmDisabled}><InterfaceText text={"Confirm order"}/></Button>
          </div>
          <div className="portal-order-workspace__toolbar-summary">
            <span>{orderQuantity.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={" pcs"}/></span>
            <strong>{formatMoney(orderSubtotal, currency)}</strong>
          </div>
        </div>

        {unpricedLines > 0 ? <div className="portal-order-workspace__warning">{unpricedLines.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={" line"}/>{unpricedLines === 1 ? "" : "s"} <InterfaceText text={" have no customer price and cannot be confirmed yet."}/></div> : null}

        <div className="portal-order-workspace__grid">
          <section className="portal-order-workspace__lines" aria-label={ui("Order lines")}>
            <div className="portal-order-workspace__section-heading"><h4><InterfaceText text={"Order lines"}/></h4><span>{draftLines.length.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={" items"}/></span></div>
            {draftLines.length ? (
              <div className="portal-order-line-table" role="table" aria-label={ui("Sales order lines")}>
                <div className="portal-order-line-table__head" role="row">
                  <span><InterfaceText text={"Part"}/></span><span><InterfaceText text={"Description"}/></span><span><InterfaceText text={"Qty"}/></span><span><InterfaceText text={"Price"}/></span><span><InterfaceText text={"Amount"}/></span>
                </div>
                {draftLines.map((line) => {
                  const code = line.resolvedCode || line.requestedCode || "-";
                  const amount = line.sell_price == null ? null : Number(line.sell_price || 0) * Number(line.qty || 0);
                  return (
                    <div key={line.lineId} className="portal-order-line-table__row" role="row">
                      <div className="portal-order-line-table__part"><strong>{code}</strong><BrandPill brand={line.brand} compact withLogo /><small>{line.market_segment || "Automotive"}</small></div>
                      <div className="portal-order-line-table__description"><span>{line.description || ui("Part description")}</span>{(line.moq ?? 0) > 1 || (line.order_multiple ?? 0) > 1 ? <small className="portal-order-line-table__notice"><InterfaceText text={"Minimum "}/>{line.moq || 1}<InterfaceText text={"; order multiple "}/>{line.order_multiple || 1}.</small> : null}{line.quantity_adjustment_note ? <small className="portal-order-line-table__notice" role="status">{line.quantity_adjustment_note}</small> : null}{line.codeChangeWarning ? <small className="portal-order-line-table__notice">{line.codeChangeWarning}</small> : null}{line.lifecycle_status === "discontinued" ? <small className="portal-order-line-table__notice"><InterfaceText text={"Discontinued"}/></small> : null}</div>
                      <input className="portal-order-line-table__qty" aria-label={`Quantity for ${code}`} type="number" min={1} step={1} value={line.qty} onChange={(event) => onQuantityChange(line.lineId, Math.max(1, Number(event.target.value || 1) || 1))} />
                      <span className="portal-order-line-table__price">{formatMoney(line.sell_price, currency)}</span>
                      <strong className="portal-order-line-table__amount">{amount == null ? "—" : formatMoney(amount, currency)}</strong>
                    </div>
                  );
                })}
              </div>
            ) : <div className="portal-order-workspace__empty"><InterfaceText text={"No order lines yet. Search for a part or import a sales order file above."}/></div>}
          </section>

          <aside className="portal-order-workspace__summary" aria-label={ui("Order summary")}>
            <div className="portal-order-workspace__section-heading"><h4><InterfaceText text={"Order summary"}/></h4><span>{currency}</span></div>
            <div className="portal-order-workspace__totals"><div><span><InterfaceText text={"Lines"}/></span><strong>{draftLines.length.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")}</strong></div><div><span><InterfaceText text={"Quantity"}/></span><strong>{orderQuantity.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")} <InterfaceText text={" pcs"}/></strong></div><div className="is-total"><span><InterfaceText text={"Subtotal excl. VAT"}/></span><strong>{formatMoney(orderSubtotal, currency)}</strong></div></div>
            <label className="portal-order-workspace__field"><span><InterfaceText text={"Delivery term"}/></span><input value={deliveryTerm} onChange={(event) => onDeliveryTermChange(event.target.value)} placeholder={ui("e.g. Standard delivery")} /></label>
            <label className="portal-order-workspace__field"><span><InterfaceText text={"Payment terms"}/></span><input value={paymentTerms} onChange={(event) => onPaymentTermsChange(event.target.value)} placeholder={ui("e.g. As agreed")} /></label>
            <label className="portal-order-workspace__field"><span><InterfaceText text={"Packing details"}/></span><input value={packingDetails} onChange={(event) => onPackingDetailsChange(event.target.value)} placeholder={ui("Optional packing instruction")} /></label>
            <label className="portal-order-workspace__field portal-order-workspace__field--message"><span><InterfaceText text={"Message to seller"}/></span><small><InterfaceText text={"Leave a note for the seller or admin team."}/></small><textarea value={orderNotes} onChange={(event) => onOrderNotesChange(event.target.value)} placeholder={ui("Write a message for the seller or admin team")} rows={3} /></label>
          </aside>
        </div>
      </section>
    </div>
  );
}
