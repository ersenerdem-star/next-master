import { useEffect, useMemo, useState } from "react";
import { fetchPortalSnapshot, loginPortal } from "../../infrastructure/api/portalAccessApi";
import type { PortalCredentials, PortalSnapshot } from "../../types/portalSession";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";

const SESSION_KEY = "next-master-portal-session";

function formatMoney(value: number, currency = "EUR") {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function readStoredCredentials(): PortalCredentials | null {
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PortalCredentials;
    if (!parsed.email || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredCredentials(credentials: PortalCredentials | null) {
  if (!credentials) {
    window.sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
}

export function PortalPage() {
  const search = new URLSearchParams(window.location.search);
  const [credentials, setCredentials] = useState<PortalCredentials>(() => {
    const stored = typeof window !== "undefined" ? readStoredCredentials() : null;
    return {
      email: search.get("email") || stored?.email || "",
      token: search.get("token") || stored?.token || "",
    };
  });
  const [snapshot, setSnapshot] = useState<PortalSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const token = search.get("token");
    const email = search.get("email");
    if (!token || !email) return;
    setLoading(true);
    setError("");
    loginPortal({ email, token })
      .then((next) => {
        setSnapshot(next);
        setStatus("Portal session active.");
        writeStoredCredentials({ email, token });
      })
      .catch((caught) => {
        setSnapshot(null);
        setError(caught instanceof Error ? caught.message : "Portal login failed");
      })
      .finally(() => setLoading(false));
  }, []);

  const accountColumns = useMemo(
    () => [
      { key: "type", header: "Document", render: (row: PortalSnapshot["accountRows"][number]) => row.document_type },
      { key: "no", header: "No", render: (row: PortalSnapshot["accountRows"][number]) => row.document_no },
      { key: "date", header: "Date", render: (row: PortalSnapshot["accountRows"][number]) => row.document_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["accountRows"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["accountRows"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["accountRows"][number]) => formatMoney(row.amount, row.currency) },
    ],
    [],
  );

  const salesOrderColumns = useMemo(
    () => [
      { key: "no", header: "Sales Order", render: (row: PortalSnapshot["salesOrders"][number]) => row.sales_order_no || row.id },
      { key: "date", header: "Date", render: (row: PortalSnapshot["salesOrders"][number]) => row.quote_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["salesOrders"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["salesOrders"][number]) => formatMoney(Number(row.sales_total || 0), row.currency) },
    ],
    [],
  );

  const invoiceColumns = useMemo(
    () => [
      { key: "no", header: "Invoice", render: (row: PortalSnapshot["invoices"][number]) => row.id },
      { key: "sales", header: "Sales Order", render: (row: PortalSnapshot["invoices"][number]) => row.sales_order_no || "-" },
      { key: "date", header: "Date", render: (row: PortalSnapshot["invoices"][number]) => row.quote_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["invoices"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["invoices"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["invoices"][number]) => formatMoney(row.total_amount, row.currency) },
    ],
    [],
  );

  const purchaseOrderColumns = useMemo(
    () => [
      { key: "no", header: "Purchase Order", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.id },
      { key: "sales", header: "Sales Order", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.sales_order_no || "-" },
      { key: "customer", header: "Customer", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.customer_name || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["purchaseOrders"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["purchaseOrders"][number]) => formatMoney(Number(row.total_amount || 0), row.currency) },
    ],
    [],
  );

  const billColumns = useMemo(
    () => [
      { key: "no", header: "Bill", render: (row: PortalSnapshot["bills"][number]) => row.id },
      { key: "po", header: "Purchase Order", render: (row: PortalSnapshot["bills"][number]) => row.purchase_order_no || "-" },
      { key: "date", header: "Date", render: (row: PortalSnapshot["bills"][number]) => row.bill_date || "-" },
      { key: "due", header: "Due Date", render: (row: PortalSnapshot["bills"][number]) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["bills"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["bills"][number]) => formatMoney(row.total_amount, row.currency) },
    ],
    [],
  );

  const paymentColumns = useMemo(
    () => [
      { key: "no", header: "Payment", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.id },
      { key: "ref", header: "Reference", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.reference_no || "-" },
      { key: "method", header: "Method", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.method || "-" },
      { key: "date", header: "Date", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.received_date || row.payment_date || "-" },
      { key: "status", header: "Status", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => row.status || "-" },
      { key: "amount", header: "Amount", render: (row: PortalSnapshot["paymentsReceived"][number] | PortalSnapshot["paymentsMade"][number]) => formatMoney(row.amount, row.currency) },
    ],
    [],
  );

  async function handleLogin() {
    try {
      setLoading(true);
      setError("");
      const next = await loginPortal(credentials);
      setSnapshot(next);
      setStatus("Portal session active.");
      writeStoredCredentials(credentials);
    } catch (caught) {
      setSnapshot(null);
      setError(caught instanceof Error ? caught.message : "Portal login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRefresh() {
    try {
      setLoading(true);
      setError("");
      const next = await fetchPortalSnapshot(credentials);
      setSnapshot(next);
      setStatus("Portal data refreshed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal refresh failed");
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    setSnapshot(null);
    setStatus("");
    setError("");
    writeStoredCredentials(null);
  }

  if (!snapshot) {
    return (
      <div className="portal-shell">
        <div className="portal-login-card">
          <h1>Portal Login</h1>
          <p>Enter invite email and token to access customer or vendor self-service.</p>
          <div className="portal-login-form">
            <Input label="Email" value={credentials.email} placeholder="name@company.com" onChange={(value) => setCredentials((current) => ({ ...current, email: value }))} />
            <Input label="Invite Token" value={credentials.token} placeholder="Portal invite token" onChange={(value) => setCredentials((current) => ({ ...current, token: value }))} />
            <div className="inline-actions">
              <Button busy={loading} busyLabel="Signing in..." onClick={() => void handleLogin()}>
                Sign In
              </Button>
            </div>
            {error ? <div className="warning-text">{error}</div> : null}
          </div>
        </div>
      </div>
    );
  }

  const partyProfile = snapshot.customer || snapshot.vendor;

  return (
    <div className="portal-shell">
      <div className="portal-header">
        <div className="portal-brand">
          {snapshot.companyProfile?.logo_data_url ? <img src={snapshot.companyProfile.logo_data_url} alt="Portal logo" className="portal-brand__logo" /> : null}
          <div>
            <h1>{snapshot.companyProfile?.company_name || "Next Master Portal"}</h1>
            <p>
              {snapshot.invite.party_type === "customer" ? "Customer Portal" : "Vendor Portal"} for {snapshot.invite.party_name}
            </p>
          </div>
        </div>
        <div className="inline-actions">
          <Button variant="secondary" busy={loading} busyLabel="Refreshing..." onClick={() => void handleRefresh()}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={handleLogout}>
            Logout
          </Button>
        </div>
      </div>

      {status ? <div className="success-text">{status}</div> : null}
      {error ? <div className="warning-text">{error}</div> : null}

      <div className="portal-summary-grid">
        <SectionCard title="Account">
          <div className="settings-grid settings-grid--compact">
            <div className="settings-item">
              <span className="settings-label">Party</span>
              <strong>{snapshot.invite.party_name}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">Email</span>
              <strong>{snapshot.invite.email}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">Billing Address</span>
              <strong>{partyProfile?.billing_address || "-"}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">Shipping Address</span>
              <strong>{partyProfile?.shipping_address || "-"}</strong>
            </div>
          </div>
        </SectionCard>
        <SectionCard title="Summary">
          <div className="dashboard-grid">
            <div className="dashboard-stat">
              <span>Total Documents</span>
              <strong>{snapshot.accountSummary.totalDocuments}</strong>
            </div>
            <div className="dashboard-stat">
              <span>Total Amount</span>
              <strong>{formatMoney(snapshot.accountSummary.totalAmount, snapshot.accountSummary.currency)}</strong>
            </div>
            <div className="dashboard-stat">
              <span>Open Balance</span>
              <strong>{formatMoney(snapshot.accountSummary.openAmount, snapshot.accountSummary.currency)}</strong>
            </div>
            <div className="dashboard-stat">
              <span>Payments</span>
              <strong>{snapshot.accountSummary.paymentCount}</strong>
            </div>
          </div>
        </SectionCard>
      </div>

      {snapshot.invite.access.can_view_account ? (
        <SectionCard title="Account Statement">
          <DataTable rows={snapshot.accountRows} columns={accountColumns} emptyText="No statement rows available." />
        </SectionCard>
      ) : null}

      {snapshot.invite.party_type === "customer" && snapshot.invite.access.can_view_orders ? (
        <SectionCard title="Sales Orders">
          <DataTable rows={snapshot.salesOrders} columns={salesOrderColumns} emptyText="No sales orders available." />
        </SectionCard>
      ) : null}

      {snapshot.invite.party_type === "customer" && snapshot.invite.access.can_view_invoices ? (
        <SectionCard title="Invoices">
          <DataTable rows={snapshot.invoices} columns={invoiceColumns} emptyText="No invoices available." />
        </SectionCard>
      ) : null}

      {snapshot.invite.party_type === "vendor" && snapshot.invite.access.can_view_orders ? (
        <SectionCard title="Purchase Orders">
          <DataTable rows={snapshot.purchaseOrders} columns={purchaseOrderColumns} emptyText="No purchase orders available." />
        </SectionCard>
      ) : null}

      {snapshot.invite.party_type === "vendor" && snapshot.invite.access.can_view_invoices ? (
        <SectionCard title="Bills">
          <DataTable rows={snapshot.bills} columns={billColumns} emptyText="No bills available." />
        </SectionCard>
      ) : null}

      {snapshot.invite.access.can_view_payments ? (
        <SectionCard title="Payments">
          <DataTable
            rows={snapshot.invite.party_type === "customer" ? snapshot.paymentsReceived : snapshot.paymentsMade}
            columns={paymentColumns}
            emptyText="No payments available."
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
