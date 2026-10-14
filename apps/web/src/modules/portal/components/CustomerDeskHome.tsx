import type { PortalSnapshot } from "../../../types/portalSession";
import { Button } from "../../../presentation/components/common/Button";
import { NavGlyph } from "../../../presentation/components/common/NextMasterBrand";

type CustomerDeskHomeProps = {
  snapshot: PortalSnapshot;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  onSearch: () => void;
  onOpenSearch: () => void;
  onOpenOrders: () => void;
  onOpenBilling: () => void;
  onOpenPriceLists: () => void;
};

function formatMoney(value: number, currency: string) {
  return `${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
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
  if (status.includes("deliver") || status.includes("paid") || status.includes("complete")) return "success";
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
  onOpenOrders,
  onOpenBilling,
  onOpenPriceLists,
}: CustomerDeskHomeProps) {
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
  const accountCredit = snapshot.accountSummary.creditAmount > 0 ? snapshot.accountSummary.creditAmount : snapshot.accountSummary.openAmount;
  const priceListLabel = snapshot.pricingProfile?.price_list_type
    ? `${snapshot.pricingProfile.price_list_type} customer price list`
    : "Customer price list";

  return (
    <div className="customer-desk-home customer-desk-home--reference">
      <section className="customer-desk-hero customer-desk-hero--reference">
        <div className="customer-desk-hero__copy">
          <span className="customer-desk-hero__eyebrow">Original quality. A wider choice.</span>
          <h2>
            <span>Find a part</span>
            <em>for your business</em>
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
                value={searchValue}
                aria-label="Search by part number, OE number, brand or vehicle"
                placeholder="Search by part number, OE number, brand or vehicle (e.g. 0986479, BOSCH, Audi A4 2019)"
                onChange={(event) => onSearchValueChange(event.target.value)}
              />
              <Button type="submit">Search <span className="customer-desk-search__arrow">›</span></Button>
            </div>
          </form>
          <nav className="customer-desk-quick-links" aria-label="Part search shortcuts">
            <button type="button" onClick={onOpenSearch}><NavGlyph name="vehicle" /><span>Search by vehicle</span><b>›</b></button>
            <button type="button" onClick={onOpenSearch}><NavGlyph name="oe" /><span>Search by OE number</span><b>›</b></button>
            <button type="button" onClick={onOpenSearch}><NavGlyph name="brand" /><span>Search by brand</span><b>›</b></button>
            <button type="button" onClick={onOpenSearch}><NavGlyph name="categories" /><span>Browse categories</span><b>›</b></button>
          </nav>
        </div>
        <div className="customer-desk-hero__part-label customer-desk-hero__part-label--braking" aria-hidden="true">
          <strong>Braking</strong>
          <span>Discs · Pads · Sensors</span>
        </div>
      </section>

      <section className="customer-desk-metrics" aria-label="Account summary">
        <button type="button" className="customer-desk-metric customer-desk-metric--blue" onClick={onOpenBilling}>
          <span className="customer-desk-metric__icon"><NavGlyph name="credit" /></span>
          <span className="customer-desk-metric__body"><small>Account credit</small><strong>{formatMoney(accountCredit, currency)}</strong><em>View statement</em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
        <button type="button" className="customer-desk-metric customer-desk-metric--green" onClick={onOpenOrders}>
          <span className="customer-desk-metric__icon"><NavGlyph name="documents" /></span>
          <span className="customer-desk-metric__body"><small>Open orders</small><strong>{openOrders.toLocaleString("en-US")}</strong><em>View all orders</em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
        <button type="button" className="customer-desk-metric customer-desk-metric--blue" onClick={onOpenOrders}>
          <span className="customer-desk-metric__icon"><NavGlyph name="delivery" /></span>
          <span className="customer-desk-metric__body"><small>Pending delivery</small><strong>{pendingDelivery.toLocaleString("en-US")}</strong><em>Track orders</em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
        <button type="button" className="customer-desk-metric customer-desk-metric--amber" onClick={onOpenOrders}>
          <span className="customer-desk-metric__icon"><NavGlyph name="warning" /></span>
          <span className="customer-desk-metric__body"><small>Items requiring action</small><strong>{actionRows.size.toLocaleString("en-US")}</strong><em>View details</em></span>
          <b className="customer-desk-metric__arrow">›</b>
        </button>
      </section>

      <div className="customer-desk-reference-grid">
        <section className="customer-desk-panel customer-desk-panel--orders">
          <div className="customer-desk-panel__header">
            <h3>Recent orders</h3>
            <button type="button" onClick={onOpenOrders}>View all orders <b>›</b></button>
          </div>
          <div className="customer-desk-order-table" role="table" aria-label="Recent orders">
            <div className="customer-desk-order-table__head" role="row">
              <span>Order no.</span><span>Date</span><span>Items</span><span>Value</span><span>Status</span><span aria-hidden="true" />
            </div>
            {recentOrders.length ? recentOrders.map((order) => {
              const status = statusLabel(order.status, Boolean(order.portal_submitted_at));
              return (
                <button key={order.id} type="button" className="customer-desk-order-table__row" onClick={onOpenOrders} role="row">
                  <strong>{order.sales_order_no || order.id}</strong>
                  <span>{formatDate(order.updated_at || order.quote_date)}</span>
                  <span>{Number(order.line_count || order.lines?.length || 0).toLocaleString("en-US")}</span>
                  <span>{formatMoney(Number(order.sales_total || order.total_amount || 0), order.currency || currency)}</span>
                  <span className={`customer-desk-order-status customer-desk-order-status--${statusTone(order.status)}`}><i />{status}</span>
                  <b className="customer-desk-order-table__chevron">›</b>
                </button>
              );
            }) : <div className="customer-desk-empty">No submitted orders are available yet.</div>}
          </div>
        </section>

        <div className="customer-desk-reference-side">
          <section className="customer-desk-panel customer-desk-price-card">
            <div className="customer-desk-panel__header"><h3>Price lists</h3><button type="button" onClick={onOpenPriceLists}>View all <b>›</b></button></div>
            <div className="customer-desk-price-card__body">
              <span className="customer-desk-price-card__icon"><NavGlyph name="download" /></span>
              <div><strong>{priceListLabel}</strong><small>{snapshot.invite.party_name} · Customer pricing</small></div>
              <button type="button" onClick={onOpenPriceLists}><NavGlyph name="download" /> <span>Download (PDF)</span></button>
            </div>
          </section>

          <section className="customer-desk-panel customer-desk-upload-card">
            <div className="customer-desk-panel__header"><h3>Product data upload</h3><button type="button" onClick={onOpenOrders}>View all <b>›</b></button></div>
            <button type="button" className="customer-desk-upload-card__file" onClick={onOpenOrders}>
              <span className="customer-desk-upload-card__file-icon"><NavGlyph name="upload" /></span>
              <span><strong>Upload from Orders</strong><small>Customer order file · available in Orders</small></span>
              <b>⋮</b>
            </button>
            <div className="customer-desk-upload-card__stepper" aria-label="Upload status">
              <span className="customer-desk-step customer-desk-step--current"><i>1</i><b>Received</b><small>Ready</small></span>
              <span className="customer-desk-step__line" />
              <span className="customer-desk-step"><i>2</i><b>Validated</b><small>After upload</small></span>
              <span className="customer-desk-step__line" />
              <span className="customer-desk-step"><i>3</i><b>Published</b><small>After validation</small></span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
