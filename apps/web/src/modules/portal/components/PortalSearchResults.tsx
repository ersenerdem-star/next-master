import { useState, type FormEvent } from "react";
import type { PortalSnapshot } from "../../../types/portalSession";
import { Button } from "../../../presentation/components/common/Button";
import { BrandPill } from "../../../presentation/components/common/BrandPill";
import { ProductVisual } from "../../../presentation/components/common/ProductVisual";
import { VehicleBadges } from "../../../presentation/components/common/VehicleBadges";
import type { PortalCatalogSearchItem, PortalPreparedLine, PortalSearchField } from "../../../infrastructure/api/portalOrderApi";

type PortalSearchResultsProps = {
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
  onSaveBasket: () => void;
  onClearBasket: () => void;
  onConfirmBasket: () => void;
  selectedCode: string;
  onSelect: (item: PortalCatalogSearchItem) => void;
  onAdd: (item: PortalCatalogSearchItem) => void;
  onPreview?: (item: PortalCatalogSearchItem) => void;
};

function formatMoney(value: number | null | undefined, currency: string) {
  if (value == null) return "Price on request";
  return `${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatDate(value?: string) {
  if (!value) return "No order history";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(date);
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
  onSaveBasket,
  onClearBasket,
  onConfirmBasket,
  selectedCode,
  onSelect,
  onAdd,
  onPreview,
}: PortalSearchResultsProps) {
  const [searchField, setSearchField] = useState<PortalSearchField>("part_number");
  const selected = results.find((item) => item.code === selectedCode) || results[0] || null;
  const visibleResults = results.slice(0, 12);
  const documentRows = snapshot.invite.party_type === "customer" ? snapshot.salesOrders : snapshot.purchaseOrders;
  const matchedOrder = selected
    ? documentRows.find((order) => (order.lines || []).some((line) => hasProductCode(line, selected.code)))
    : null;
  const latestOrder = matchedOrder || documentRows[0] || null;
  const selectedOrderLine = latestOrder?.lines?.find((line) => hasProductCode(line, selected?.code || ""));
  const openInvoice = (snapshot.invite.party_type === "customer" ? snapshot.invoices : snapshot.bills).find(
    (invoice) => !["paid", "settled", "closed"].includes(String(invoice.status || "").toLowerCase()),
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(searchField);
  }

  const searchTabs: Array<{ value: PortalSearchField; label: string }> = [
    { value: "part_number", label: "Part number" },
    { value: "oem", label: "OEM" },
    { value: "vehicle", label: "Vehicle" },
    { value: "description", label: "Description" },
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
        <div className="portal-search-result-view__types" role="tablist" aria-label="Search type">
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
          <select aria-label="Search brand" value={brand} onChange={(event) => onBrandChange(event.target.value)}>
            {brands.map((option) => <option key={option.value || "all"} value={option.value}>{option.label}</option>)}
          </select>
          <input aria-label={`${searchTabs.find((tab) => tab.value === searchField)?.label || "Part"} search`} placeholder={searchPlaceholder[searchField]} value={query} onChange={(event) => onQueryChange(event.target.value)} />
          <button type="button" className="portal-search-result-view__clear" onClick={onClear} aria-label="Clear search">×</button>
          <button type="submit" className="portal-search-result-view__submit" disabled={searching}>{searching ? "…" : "Search"}</button>
        </form>
        <div className="portal-search-result-view__actions" aria-label="Import and export tools">
          <div className="portal-search-result-view__action-group">
            <span className="portal-search-result-view__action-label">Order tools</span>
            <Button type="button" variant="secondary" onClick={onImport}>
              Import Excel
            </Button>
            <Button type="button" variant="secondary" onClick={onTemplate}>
              Template
            </Button>
            <Button type="button" variant="secondary" onClick={onExport} disabled={exportDisabled}>
              Export basket
            </Button>
          </div>
          <div className="portal-search-result-view__action-status" aria-live="polite">
            <strong>{basketCount.toLocaleString("en-US")} basket line{basketCount === 1 ? "" : "s"}</strong>
            <span>{orderStatus || "Import a file or add a search result to build the basket."}</span>
          </div>
        </div>
      </div>

      <div className="portal-search-result-view__layout">
        <aside className="portal-search-result-rail" aria-label="Search results">
          <div className="portal-search-result-rail__summary">
            {results.length.toLocaleString("en-US")} result{results.length === 1 ? "" : "s"} for “{query || "all parts"}”
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
                  <span>{compactText(item.description || "Part description", 48)}</span>
                  <small>{item.available_qty == null ? "Stock check" : `${Number(item.available_qty).toLocaleString("en-US")} in stock`}</small>
                </span>
                <span className="portal-search-result-rail__chevron">›</span>
              </button>
            ))}
          </div>
          {results.length > visibleResults.length ? <button type="button" className="portal-search-result-rail__all">View all {results.length.toLocaleString("en-US")} results</button> : null}
        </aside>

        <main className="portal-search-result-main">
          {selected ? (
            <>
              <div className="portal-search-result-main__header">
                <div>
                  <span className="portal-search-result-main__eyebrow">Selected part</span>
                  <h2>{selected.code}</h2>
                  <p>{selected.description || "Part description"}</p>
                  <span>{selected.market_segment || "Automotive"}</span>
                </div>
                <BrandPill brand={selected.brand} compact withLogo />
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
                  <div className="portal-search-result-main__stock"><span />{selected.available_qty == null ? "Stock check" : `${Number(selected.available_qty).toLocaleString("en-US")} pcs available`}</div>
                  <strong className="portal-search-result-main__price">{formatMoney(selected.sell_price, selected.currency || currency)}</strong>
                  <span className="portal-search-result-main__price-note">Your customer price · Excl. VAT</span>
                  <div className="portal-search-result-main__actions">
                    <select aria-label="Quantity" defaultValue="1"><option>1</option><option>2</option><option>5</option><option>10</option></select>
                    <Button onClick={() => onAdd(selected)}>Add to basket</Button>
                  </div>
                  <button type="button" className="portal-search-result-main__secondary" onClick={() => onPreview?.(selected)}>View larger / details</button>
                </div>
              </div>
              {selected.replacement_warning ? (
                <div className="portal-search-result-main__notice"><strong>Replacement note</strong><span>{selected.replacement_warning}</span></div>
              ) : null}
              <div className="portal-search-result-main__facts">
                <section><h3>OEM references</h3><p>{selected.oem_no || "No OEM references recorded"}</p><button type="button" onClick={() => onPreview?.(selected)}>Show all references</button></section>
                <section><h3>Vehicle compatibility</h3><div className="portal-search-result-main__vehicle"><VehicleBadges value={selected.vehicle || ""} limit={5} expandable /></div><button type="button" onClick={() => onPreview?.(selected)}>View compatible vehicles</button></section>
              </div>
              <div className="portal-search-result-main__metadata">
                <span>Tariff {selected.tariff || "-"}</span>
                <span>Origin {selected.origin || "-"}</span>
                <span>Weight {selected.weight_kg == null ? "-" : `${selected.weight_kg} kg`}</span>
                <span>Supplier {selected.supplier_name || "-"}</span>
              </div>
            </>
          ) : <div className="empty-state">Search by part number, OEM, vehicle or description.</div>}
        </main>

        <aside className="portal-search-result-insights" aria-label="Account insights">
          <section className="portal-search-insight-card">
            <h3>Last ordered</h3>
            <small>{formatDate(latestOrder?.updated_at || latestOrder?.quote_date)}</small>
            <strong>{selected?.code || "-"}</strong>
            <span>{selectedOrderLine?.description || latestOrder?.status || "No previous order for this part"}</span>
            {selectedOrderLine?.qty ? <small>Qty: {selectedOrderLine.qty}</small> : null}
            <button type="button" onClick={() => onPreview?.(selected || results[0])}>View order history ›</button>
          </section>
          <section className="portal-search-insight-card">
            <h3>Price movement <small>(customer price)</small></h3>
            <strong>{selected ? formatMoney(selected.sell_price, selected.currency || currency) : "-"}</strong>
            <span>No prior movement data available yet.</span>
            <div className="portal-search-insight-card__line" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
            <button type="button" onClick={() => onPreview?.(selected || results[0])}>View price details ›</button>
          </section>
          <section className="portal-search-insight-card portal-search-insight-card--invoice">
            <h3>Open invoice reminder</h3>
            <strong>{openInvoice ? formatMoney(openInvoice.total_amount, openInvoice.currency || currency) : "No open invoice"}</strong>
            <span>{openInvoice ? `Due date: ${formatDate(openInvoice.due_date)}` : "Your account is up to date."}</span>
            <button type="button" onClick={() => onPreview?.(selected || results[0])}>View invoices ›</button>
          </section>
        </aside>
      </div>

      <section className="portal-search-result-basket" aria-label="Basket">
        <div className="portal-search-result-basket__header">
          <div>
            <span className="portal-search-result-view__eyebrow">Order workspace</span>
            <h3>Basket ({draftLines.length.toLocaleString("en-US")})</h3>
            <p>{draftLines.length ? "Review imported or selected lines before saving or confirming the basket." : "Import a file or add a search result to build the basket here."}</p>
          </div>
          <div className="portal-search-result-basket__actions">
            <Button variant="secondary" busy={savingBasket} busyLabel="Saving..." onClick={onSaveBasket} disabled={!draftLines.length}>
              Save Basket
            </Button>
            <Button variant="secondary" onClick={onClearBasket} disabled={!draftLines.length}>
              Clear
            </Button>
            <Button busy={confirmingBasket} busyLabel="Confirming..." onClick={onConfirmBasket} disabled={!draftLines.length || confirmDisabled}>
              Confirm Basket
            </Button>
          </div>
        </div>
        {draftLines.length ? (
          <div className="portal-search-result-basket__lines">
            {draftLines.slice(0, 6).map((line) => (
              <div key={line.lineId} className="portal-search-result-basket__line">
                <strong>{line.resolvedCode || line.requestedCode || "-"}</strong>
                <span>{line.description || "Part description"}</span>
                <small>Qty {line.qty} · {line.sell_price == null ? "Price on request" : formatMoney(line.sell_price, currency)}</small>
              </div>
            ))}
            {draftLines.length > 6 ? <div className="portal-search-result-basket__more">+{(draftLines.length - 6).toLocaleString("en-US")} more line{draftLines.length - 6 === 1 ? "" : "s"} in basket</div> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
