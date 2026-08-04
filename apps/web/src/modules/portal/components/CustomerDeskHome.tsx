import type { PortalSnapshot } from "../../../types/portalSession";
import { Button } from "../../../presentation/components/common/Button";

type CustomerDeskHomeProps = {
  snapshot: PortalSnapshot;
  searchValue: string;
  onSearchValueChange: (value: string) => void;
  onSearch: () => void;
  onOpenSearch: () => void;
  onOpenOrders: () => void;
  onOpenBilling: () => void;
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

function greetingForHour(hour: number) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function CustomerDeskHome({
  snapshot,
  searchValue,
  onSearchValueChange,
  onSearch,
  onOpenSearch,
  onOpenOrders,
  onOpenBilling,
}: CustomerDeskHomeProps) {
  const customerName = snapshot.customer?.display_name || snapshot.invite.contact_name || snapshot.invite.party_name;
  const currency = snapshot.accountSummary.currency || snapshot.pricingProfile?.currency || "EUR";
  const now = new Date();
  const recentOrders = [...snapshot.salesOrders]
    .filter((row) => !(row.source_channel === "portal" && !row.portal_submitted_at && String(row.status || "").toLowerCase() === "draft"))
    .sort((left, right) => {
      const leftTime = new Date(left.updated_at || left.quote_date || 0).getTime();
      const rightTime = new Date(right.updated_at || right.quote_date || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, 5);
  const savedBasketCount = snapshot.salesOrders.filter(
    (row) => row.source_channel === "portal" && !row.portal_submitted_at && String(row.status || "").toLowerCase() === "draft",
  ).length;
  const dueSoonCount = snapshot.accountRows.filter((row) => {
    const status = String(row.status || "").toLowerCase();
    if (status === "paid") return false;
    if (!row.due_date) return false;
    const dueAt = new Date(row.due_date).getTime();
    if (!Number.isFinite(dueAt)) return false;
    const days = (dueAt - now.getTime()) / (24 * 60 * 60 * 1000);
    return days >= 0 && days <= 30;
  }).length;
  const latestOrder = recentOrders[0] || null;
  const observedSegments = new Set(
    snapshot.salesOrders
      .flatMap((order) => order.lines || [])
      .map((line) => String(line.market_segment || "").trim().toUpperCase())
      .filter(Boolean),
  );
  const recommendationContext = observedSegments.size === 1 ? [...observedSegments][0] : null;

  return (
    <div className="customer-desk-home">
      <section className="customer-desk-hero">
        <div className="customer-desk-hero__copy">
          <span className="customer-desk-hero__eyebrow">Customer Desk</span>
          <h2>{greetingForHour(now.getHours())}, {customerName}.</h2>
          <p>Find the right part, review your price, and keep your orders moving.</p>
        </div>
        <form
          className="customer-desk-search"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <label htmlFor="customer-desk-search">Part number, OEM, description or vehicle</label>
          <div className="customer-desk-search__control">
            <input
              id="customer-desk-search"
              value={searchValue}
              placeholder="What are you looking for?"
              onChange={(event) => onSearchValueChange(event.target.value)}
            />
            <Button type="submit">Search</Button>
          </div>
        </form>
      </section>

      <div className="customer-desk-actions" aria-label="Quick actions">
        <button type="button" onClick={onOpenSearch}>
          <span>Search parts</span>
          <small>Part number and OEM lookup</small>
        </button>
        <button type="button" onClick={onOpenOrders}>
          <span>{savedBasketCount ? `Continue ${savedBasketCount} saved basket${savedBasketCount === 1 ? "" : "s"}` : "View recent orders"}</span>
          <small>Reorder and order tracking</small>
        </button>
        {snapshot.invite.access.can_view_invoices ? (
          <button type="button" onClick={onOpenBilling}>
            <span>Review billing</span>
            <small>Invoices, due dates and payments</small>
          </button>
        ) : null}
      </div>

      <section className="customer-desk-account" aria-label="Account at a glance">
        <div>
          <span>Open balance</span>
          <strong>{formatMoney(snapshot.accountSummary.openAmount, currency)}</strong>
          <small>Current account position</small>
        </div>
        <div>
          <span>Due soon</span>
          <strong>{dueSoonCount.toLocaleString("en-US")} document{dueSoonCount === 1 ? "" : "s"}</strong>
          <small>Due within 30 days</small>
        </div>
        <div>
          <span>Latest order</span>
          <strong>{latestOrder?.sales_order_no || "No order yet"}</strong>
          <small>{latestOrder ? `${latestOrder.status || "Status unavailable"} · ${formatDate(latestOrder.updated_at || latestOrder.quote_date)}` : "Start with a part search"}</small>
        </div>
        <div>
          <span>Available credit</span>
          <strong>Not available</strong>
          <small>Shown only when supplied by the account source</small>
        </div>
      </section>

      <div className="customer-desk-main-grid">
        <section className="customer-desk-panel">
          <div className="customer-desk-panel__header">
            <div>
              <span>Orders</span>
              <h3>Recent orders</h3>
            </div>
            <button type="button" onClick={onOpenOrders}>View all</button>
          </div>
          {recentOrders.length ? (
            <div className="customer-desk-order-list">
              {recentOrders.map((order) => (
                <button key={order.id} type="button" onClick={onOpenOrders}>
                  <strong>{order.sales_order_no || order.id}</strong>
                  <span>{formatDate(order.updated_at || order.quote_date)}</span>
                  <span>{order.status || "—"}</span>
                  <span>{formatMoney(Number(order.sales_total || order.total_amount || 0), order.currency || currency)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="customer-desk-empty">No submitted orders are available yet.</div>
          )}
        </section>

        <section className="customer-desk-panel customer-desk-panel--recommendation">
          <div className="customer-desk-panel__header">
            <div>
              <span>For you</span>
              <h3>Verified recommendations</h3>
            </div>
          </div>
          <div className="customer-desk-recommendation-state">
            <strong>{recommendationContext ? `${recommendationContext} profile detected` : "Building a reliable profile"}</strong>
            <p>
              Suggestions appear only after segment, purchase-history, customer-price and availability checks pass.
              Unverified brand or vehicle recommendations stay hidden.
            </p>
            <Button variant="secondary" onClick={onOpenSearch}>Start a focused search</Button>
          </div>
        </section>
      </div>
    </div>
  );
}
