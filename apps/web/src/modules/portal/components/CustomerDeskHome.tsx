import {useI18n} from "../../../i18n/I18nProvider";
import {InterfaceText,useInterfaceText} from "../../../i18n/InterfaceText";
import type {PortalSearchField} from "../../../infrastructure/api/portalOrderApi";
import type { PortalSnapshot } from "../../../types/portalSession";
import { useState } from "react";
import { Button } from "../../../presentation/components/common/Button";
import { NavGlyph } from "../../../presentation/components/common/NextMasterBrand";

type CustomerDeskHomeProps = {
  snapshot: PortalSnapshot;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  onSearch: () => void;
  onOpenSearch: (field?:PortalSearchField) => void;
  onOpenStatement: () => void;
  onOpenOrder: (id:string) => void;
  onOpenOrders: () => void;
  onOpenBilling: () => void;
  onOpenPriceLists: () => void;
};

function formatMoneyForLocale(value: number, currency: string, locale = "en") {
  return `${Number(value || 0).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatDateForLocale(value?: string, locale = "en") {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function normaliseStatus(value?: string | null) {
  return String(value || "").trim().toLowerCase().replaceAll("_", " ");
}

function statusLabel(value?: string | null, submitted = false) {
  const status = normaliseStatus(value);
  if (!status) return submitted ? "Submitted" : "Draft";
  return status.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(value?: string | null) {
  const status = normaliseStatus(value);
  if (["delivered", "paid", "fully paid", "complete", "completed"].includes(status)) return "success";
  if (status.includes("dispatch") || status.includes("ship") || status.includes("process")) return "info";
  if (status.includes("cancel") || status.includes("reject")) return "danger";
  return "warning";
}

export function CustomerDeskHome({
  snapshot,
  searchValue,
  onSearchValueChange,
  onSearch,
  onOpenSearch,
  onOpenStatement,
  onOpenOrder,
  onOpenOrders,
  onOpenBilling,
  onOpenPriceLists,
}: CustomerDeskHomeProps) {
  const ui=useInterfaceText();
  const {locale}=useI18n();
  const formatMoney=(value: number, currency: string)=>ui(formatMoneyForLocale(value,currency,locale));
  const formatDate=(value?:string)=>ui(formatDateForLocale(value,locale));
  // The home search is a fresh entry point. Keep it local so returning from
  // Part Search does not surface the previous query in the approved hero
  // composition; the parent still receives every keystroke for submission.
  const [homeSearchValue, setHomeSearchValue] = useState("");
  const currency = snapshot.accountSummary.currency || snapshot.pricingProfile?.currency || "EUR";
  const recentOrders = [...snapshot.salesOrders]
    .filter((row) => !(row.source_channel === "portal" && !row.portal_submitted_at && normaliseStatus(row.status) === "draft"))
    .sort((left, right) => {
      const leftTime = new Date(left.updated_at || left.quote_date || 0).getTime();
      const rightTime = new Date(right.updated_at || right.quote_date || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, 5);
  const allOrders = snapshot.salesOrders;
  const terminalStatuses = new Set(["delivered", "cancelled", "canceled", "closed", "complete", "completed"]);
  const openOrders = allOrders.filter((row) => !terminalStatuses.has(normaliseStatus(row.status))).length;
  const pendingDelivery = allOrders.filter((row) => {
    const status = normaliseStatus(row.status);
    return status.includes("dispatch") || status.includes("ship") || status.includes("pending") || status.includes("confirm") || status.includes("process");
  }).length;
  const actionRows = new Set<string>();
  snapshot.accountRows.forEach((row) => {
    const status = normaliseStatus(row.status);
    if (status === "overdue" || status === "unpaid") actionRows.add(row.document_no);
  });
  snapshot.salesOrders.forEach((order) => {
    (order.lines || []).forEach((line, index) => {
      if (line.sell_price == null || line.lifecycle_status === "discontinued") actionRows.add(`${order.id}:${index}`);
    });
  });
  const accountCredit = snapshot.accountSummary.creditAmount;
  const priceListLabel = snapshot.pricingProfile?.price_list_type
    ? `${snapshot.pricingProfile.price_list_type} customer price list`
    : "Customer price list";

  return (
    <div className="customer-desk-home customer-desk-home--reference">
      <section className="customer-desk-hero customer-desk-hero--reference">
        <div className="customer-desk-hero__copy">
          <span className="customer-desk-hero__eyebrow"><InterfaceText text={"Original quality. A wider choice."}/></span>
          <h2>
            <span><InterfaceText text={"Find a part"}/></span>
            <em><InterfaceText text={"for your business"}/></em>
          </h2>
          <form
            className="customer-desk-search"
            onSubmit={(event) => {
              event.preventDefault();
              onSearch();
            }}
          >
            <div className="customer-desk-search__control">
              <NavGlyph name="search" />
              <input
                id="customer-desk-search"
                value={homeSearchValue}
                aria-label={ui("Search by part number, OE number, brand or vehicle")}
                placeholder={ui("Search by part number, OE number, brand or vehicle (e.g. 0986479, BOSCH, Audi A4 2019)")}
                onChange={(event) => {
                  setHomeSearchValue(event.target.value);
                  onSearchValueChange(event.target.value);
                }}
              />
              <Button type="submit"><InterfaceText text={"Search "}/><span className="customer-desk-search__arrow">›</span></Button>
            </div>
          </form>
          <nav className="customer-desk-quick-links" aria-label={ui("Part search shortcuts")}>
            <button type="button" onClick={() => onOpenSearch("vehicle")}><NavGlyph name="vehicle" /><span><InterfaceText text={"Search by vehicle"}/></span><b>›</b></button>
            <button type="button" onClick={() => onOpenSearch("oem")}><NavGlyph name="oe" /><span><InterfaceText text={"Search by OE number"}/></span><b>›</b></button>
            <button type="button" onClick={() => onOpenSearch("part_number")}><NavGlyph name="brand" /><span><InterfaceText text={"Search by brand"}/></span><b>›</b></button>
            <button type="button" onClick={() => onOpenSearch("description")}><NavGlyph name="categories" /><span><InterfaceText text={"Search by description"}/></span><b>›</b></button>
          </nav>
        </div>
        <div className="customer-desk-hero__part-label customer-desk-hero__part-label--braking" aria-hidden="true">
          <strong><InterfaceText text={"Braking"}/></strong>
          <span><InterfaceText text={"Discs · Pads · Sensors"}/></span>
        </div>
      </section>

      <section className="customer-desk-metrics" aria-label={ui("Account summary")}>
        <button type="button" className="customer-desk-metric customer-desk-metric--blue" onClick={onOpenStatement}>
          <span className="customer-desk-metric__icon"><NavGlyph name="credit" /></span>
          <span className="customer-desk-metric__body"><small><InterfaceText text={"Account credit"}/></small><strong>{formatMoney(accountCredit, currency)}</strong><em><InterfaceText text={"View statement"}/></em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
        <button type="button" className="customer-desk-metric customer-desk-metric--green" onClick={onOpenOrders}>
          <span className="customer-desk-metric__icon"><NavGlyph name="documents" /></span>
          <span className="customer-desk-metric__body"><small><InterfaceText text={"Open orders"}/></small><strong>{openOrders.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")}</strong><em><InterfaceText text={"View all orders"}/></em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
        <button type="button" className="customer-desk-metric customer-desk-metric--blue" onClick={onOpenOrders}>
          <span className="customer-desk-metric__icon"><NavGlyph name="delivery" /></span>
          <span className="customer-desk-metric__body"><small><InterfaceText text={"Pending delivery"}/></small><strong>{pendingDelivery.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")}</strong><em><InterfaceText text={"Track orders"}/></em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
        <button type="button" className="customer-desk-metric customer-desk-metric--amber" onClick={onOpenOrders}>
          <span className="customer-desk-metric__icon"><NavGlyph name="warning" /></span>
          <span className="customer-desk-metric__body"><small><InterfaceText text={"Items requiring action"}/></small><strong>{actionRows.size.toLocaleString(locale === "tr" ? "tr-TR" : "en-US")}</strong><em><InterfaceText text={"View details"}/></em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
      </section>

      <div className="customer-desk-reference-grid">
        <section className="customer-desk-panel customer-desk-panel--orders">
          <div className="customer-desk-panel__header">
            <h3><InterfaceText text={"Recent orders"}/></h3>
            <button type="button" onClick={onOpenOrders}><InterfaceText text={"View all orders "}/><b>›</b></button>
          </div>
          <div className="customer-desk-order-table" role="table" aria-label={ui("Recent orders")}>
            <div className="customer-desk-order-table__head" role="row">
              <span><InterfaceText text={"Order no."}/></span><span><InterfaceText text={"Date"}/></span><span><InterfaceText text={"Items"}/></span><span><InterfaceText text={"Value"}/></span><span><InterfaceText text={"Status"}/></span><span aria-hidden="true" />
            </div>
            {recentOrders.length ? recentOrders.map((order) => {
              const status = statusLabel(order.status, Boolean(order.portal_submitted_at));
              return (
                <button key={order.id} type="button" className="customer-desk-order-table__row" onClick={() => onOpenOrder(order.id)} role="row">
                  <strong>{order.sales_order_no || order.id}</strong>
                  <span>{formatDate(order.updated_at || order.quote_date)}</span>
                  <span>{Number(order.line_count || order.lines?.length || 0).toLocaleString(locale === "tr" ? "tr-TR" : "en-US")}</span>
                  <span>{formatMoney(Number(order.sales_total || order.total_amount || 0), order.currency || currency)}</span>
                  <span className={`customer-desk-order-status customer-desk-order-status--${statusTone(order.status)}`}><i />{ui(status)}</span>
                  <b className="customer-desk-order-table__chevron">›</b>
                </button>
              );
            }) : <div className="customer-desk-empty"><InterfaceText text={"No submitted orders are available yet."}/></div>}
          </div>
        </section>

        <div className="customer-desk-reference-side">
          <section className="customer-desk-panel customer-desk-price-card">
            <div className="customer-desk-panel__header"><h3><InterfaceText text={"Price lists"}/></h3><button type="button" onClick={onOpenPriceLists}><InterfaceText text={"View all "}/><b>›</b></button></div>
            <div className="customer-desk-price-card__body">
              <span className="customer-desk-price-card__icon"><NavGlyph name="download" /></span>
              <div><strong>{ui(priceListLabel)}</strong><small>{snapshot.invite.party_name} <InterfaceText text={" · Customer pricing"}/></small></div>
              <button type="button" onClick={onOpenPriceLists}><NavGlyph name="download" /> <span><InterfaceText text={"Open price list downloads"}/></span></button>
            </div>
          </section>

          <section className="customer-desk-panel customer-desk-upload-card">
            <div className="customer-desk-panel__header"><h3><InterfaceText text={"Product data upload"}/></h3><button type="button" onClick={onOpenOrders}><InterfaceText text={"View all "}/><b>›</b></button></div>
            <button type="button" className="customer-desk-upload-card__file" onClick={onOpenOrders}>
              <span className="customer-desk-upload-card__file-icon"><NavGlyph name="upload" /></span>
              <span><strong><InterfaceText text={"Upload from Orders"}/></strong><small><InterfaceText text={"Customer order file · available in Orders"}/></small></span>
              <b>⋮</b>
            </button>
            <p><InterfaceText text={"Choose an order file in Orders to start an import."}/></p>
          </section>
        </div>
      </div>
    </div>
  );
}
