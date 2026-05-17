import { useEffect, useMemo, useState } from "react";
import { fetchPortalSnapshot, loginPortal } from "../../infrastructure/api/portalAccessApi";
import type { PortalCredentials, PortalSnapshot } from "../../types/portalSession";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { SectionCard } from "../components/common/SectionCard";
import { buildBusinessDocumentHtml } from "../../shared/documentPrint";

const SESSION_KEY = "next-master-portal-session";

function formatMoney(value: number, currency = "EUR") {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatWeight(value: number | null | undefined) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function formatDate(value?: string) {
  return value || "-";
}

type PortalSelection =
  | { kind: "sales-order"; id: string }
  | { kind: "invoice"; id: string }
  | { kind: "purchase-order"; id: string }
  | { kind: "bill"; id: string };

type PortalLine = NonNullable<PortalSnapshot["invoices"][number]["lines"]>[number];

function matchesSearch(value: string, row: { id: string; sales_order_no?: string; lines?: PortalLine[] }) {
  if (!value) return true;
  const needle = value.trim().toLowerCase();
  if (!needle) return true;
  const headerText = [row.id, row.sales_order_no || ""].join(" ").toLowerCase();
  if (headerText.includes(needle)) return true;
  return (row.lines || []).some((line) =>
    [line.code, line.requested_code, line.old_code, line.brand, line.description, line.oem_no]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

function matchesBrand(value: string, row: { lines?: PortalLine[] }) {
  if (!value) return true;
  return (row.lines || []).some((line) => String(line.brand || "").toLowerCase() === value.toLowerCase());
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
  const [selection, setSelection] = useState<PortalSelection | null>(null);
  const [documentSearch, setDocumentSearch] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
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
        setSelection(null);
        setDocumentSearch("");
        setBrandFilter("");
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
      setSelection(null);
      setDocumentSearch("");
      setBrandFilter("");
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
      setSelection(null);
      setStatus("Portal data refreshed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal refresh failed");
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    setSnapshot(null);
    setSelection(null);
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

  const activeSnapshot = snapshot;
  const partyProfile = activeSnapshot.customer || activeSnapshot.vendor;
  const visibleDocumentRows = useMemo(
    () =>
      activeSnapshot.invite.party_type === "customer"
        ? [...activeSnapshot.salesOrders, ...activeSnapshot.invoices]
        : [...activeSnapshot.purchaseOrders, ...activeSnapshot.bills],
    [activeSnapshot],
  );

  const brandOptions = useMemo(() => {
    const brands = new Set<string>();
    visibleDocumentRows.forEach((row) => {
      (row.lines || []).forEach((line) => {
        const brand = String(line.brand || "").trim();
        if (brand) brands.add(brand);
      });
    });
    return [{ value: "", label: "All Brands" }, ...Array.from(brands).sort((a, b) => a.localeCompare(b)).map((brand) => ({ value: brand, label: brand }))];
  }, [visibleDocumentRows]);

  const filteredSalesOrders = useMemo(
    () => activeSnapshot.salesOrders.filter((row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row)),
    [activeSnapshot.salesOrders, documentSearch, brandFilter],
  );
  const filteredInvoices = useMemo(
    () => activeSnapshot.invoices.filter((row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row)),
    [activeSnapshot.invoices, documentSearch, brandFilter],
  );
  const filteredPurchaseOrders = useMemo(
    () => activeSnapshot.purchaseOrders.filter((row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row)),
    [activeSnapshot.purchaseOrders, documentSearch, brandFilter],
  );
  const filteredBills = useMemo(
    () => activeSnapshot.bills.filter((row) => matchesSearch(documentSearch, row) && matchesBrand(brandFilter, row)),
    [activeSnapshot.bills, documentSearch, brandFilter],
  );

  const selectedDocument = (() => {
    if (!selection) return null;
    if (selection.kind === "sales-order") {
      const row = activeSnapshot.salesOrders.find((entry) => entry.id === selection.id);
      return row ? { kind: selection.kind, row } : null;
    }
    if (selection.kind === "invoice") {
      const row = activeSnapshot.invoices.find((entry) => entry.id === selection.id);
      return row ? { kind: selection.kind, row } : null;
    }
    if (selection.kind === "purchase-order") {
      const row = activeSnapshot.purchaseOrders.find((entry) => entry.id === selection.id);
      return row ? { kind: selection.kind, row } : null;
    }
    const row = activeSnapshot.bills.find((entry) => entry.id === selection.id);
    return row ? { kind: selection.kind, row } : null;
  })();

  const detailColumns = (() => {
    if (!selectedDocument) return [];
    if (selectedDocument.kind === "sales-order" || selectedDocument.kind === "invoice") {
      return [
        { key: "code", header: "Code", render: (row: PortalLine) => row.code || row.requested_code || "-" },
        { key: "brand", header: "Brand", render: (row: PortalLine) => row.brand || "-" },
        { key: "description", header: "Description", render: (row: PortalLine) => row.description || "-" },
        { key: "qty", header: "Qty", render: (row: PortalLine) => row.qty || 0 },
        { key: "oem", header: "OEM", render: (row: PortalLine) => row.oem_no || "-" },
        { key: "origin", header: "Origin", render: (row: PortalLine) => row.origin || "-" },
        { key: "weight", header: "Weight", render: (row: PortalLine) => formatWeight(row.weight_kg) },
        { key: "unit", header: "Unit Price", render: (row: PortalLine) => formatMoney(Number(row.sell_price || 0), selectedDocument.row.currency) },
        { key: "amount", header: "Line Total", render: (row: PortalLine) => formatMoney(Number(row.line_total || row.sales_total || 0), selectedDocument.row.currency) },
      ];
    }
    return [
      { key: "code", header: "Code", render: (row: PortalLine) => row.code || "-" },
      { key: "brand", header: "Brand", render: (row: PortalLine) => row.brand || "-" },
      { key: "description", header: "Description", render: (row: PortalLine) => row.description || "-" },
      { key: "qty", header: "Qty", render: (row: PortalLine) => row.qty || 0 },
      { key: "oem", header: "OEM", render: (row: PortalLine) => row.oem_no || "-" },
      { key: "origin", header: "Origin", render: (row: PortalLine) => row.origin || "-" },
      { key: "unit", header: "Unit Price", render: (row: PortalLine) => formatMoney(Number(row.buy_price || 0), selectedDocument.row.currency) },
      { key: "amount", header: "Line Total", render: (row: PortalLine) => formatMoney(Number(row.line_total || 0), selectedDocument.row.currency) },
    ];
  })();

  const detailTitle = selectedDocument
    ? selectedDocument.kind === "sales-order"
      ? `Sales Order Detail · ${selectedDocument.row.sales_order_no || selectedDocument.row.id}`
      : selectedDocument.kind === "invoice"
        ? `Invoice Detail · ${selectedDocument.row.id}`
        : selectedDocument.kind === "purchase-order"
          ? `Purchase Order Detail · ${selectedDocument.row.id}`
          : `Bill Detail · ${selectedDocument.row.id}`
    : "";

  function handlePortalPrint() {
    if (!selectedDocument) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      setError("Popup blocked while opening PDF view.");
      return;
    }

    const isCustomerDoc = selectedDocument.kind === "sales-order" || selectedDocument.kind === "invoice";
    const currency = selectedDocument.row.currency || activeSnapshot.accountSummary.currency || "EUR";
    const lines = (selectedDocument.row.lines || []).map((line) => ({
      code: line.code || line.requested_code || line.old_code || "-",
      description: line.description || "-",
      origin: line.origin || "",
      brand: line.brand || "",
      orderNo:
        selectedDocument.kind === "sales-order"
          ? selectedDocument.row.sales_order_no || selectedDocument.row.id
          : selectedDocument.kind === "invoice"
            ? selectedDocument.row.sales_order_no || ""
            : selectedDocument.kind === "purchase-order"
              ? selectedDocument.row.id
              : selectedDocument.row.purchase_order_no || selectedDocument.row.id,
      weight: line.weight_kg == null ? "" : formatWeight(line.weight_kg),
      gtip: line.hs_code || "",
      qty: Number(line.qty || 0),
      unitPrice: Number(isCustomerDoc ? line.sell_price || 0 : line.buy_price || 0),
      amount: Number(isCustomerDoc ? line.line_total || line.sales_total || 0 : line.line_total || 0),
    }));

    const html = buildBusinessDocumentHtml({
      docType:
        selectedDocument.kind === "sales-order"
          ? "Sales Order"
          : selectedDocument.kind === "invoice"
            ? "Invoice"
            : selectedDocument.kind === "purchase-order"
              ? "Purchase Order"
              : "Bill",
      docNo:
        selectedDocument.kind === "sales-order"
          ? selectedDocument.row.sales_order_no || selectedDocument.row.id
          : selectedDocument.kind === "invoice"
            ? selectedDocument.row.id
            : selectedDocument.kind === "purchase-order"
              ? selectedDocument.row.id
              : selectedDocument.row.id,
      company: {
        companyName: activeSnapshot.companyProfile?.company_name || "Next Master",
        address: activeSnapshot.companyProfile?.address || "",
        bankDetails: activeSnapshot.companyProfile?.bank_details || "",
        taxNumber: activeSnapshot.companyProfile?.tax_number || "",
        logoDataUrl: activeSnapshot.companyProfile?.logo_data_url || "",
      },
      party: {
        title: isCustomerDoc ? "Bill To" : "Vendor",
        details: isCustomerDoc ? partyProfile?.billing_address || activeSnapshot.invite.party_name : partyProfile?.billing_address || activeSnapshot.invite.party_name,
        shippingTitle: "Shipping Address",
        shippingDetails: isCustomerDoc ? partyProfile?.shipping_address || "" : "",
      },
      meta: [
        {
          label: selectedDocument.kind === "bill" ? "Bill Date" : selectedDocument.kind === "purchase-order" ? "PO Date" : "Date",
          value:
            selectedDocument.kind === "bill"
              ? selectedDocument.row.bill_date || "-"
              : "quote_date" in selectedDocument.row
                ? selectedDocument.row.quote_date || "-"
                : "-",
        },
        ...(selectedDocument.row.payment_terms ? [{ label: "Terms", value: selectedDocument.row.payment_terms }] : []),
        ...("due_date" in selectedDocument.row && selectedDocument.row.due_date ? [{ label: "Due Date", value: selectedDocument.row.due_date }] : []),
        ...("delivery_term" in selectedDocument.row && selectedDocument.row.delivery_term ? [{ label: "Delivery Term", value: selectedDocument.row.delivery_term }] : []),
        ...("contract_nr" in selectedDocument.row && selectedDocument.row.contract_nr ? [{ label: "Contract Nr", value: selectedDocument.row.contract_nr }] : []),
        ...(selectedDocument.kind === "invoice" && selectedDocument.row.sales_order_no ? [{ label: "Sales Order", value: selectedDocument.row.sales_order_no }] : []),
        ...(selectedDocument.kind === "bill" && selectedDocument.row.purchase_order_no ? [{ label: "Purchase Order", value: selectedDocument.row.purchase_order_no }] : []),
      ],
      lines,
      totals: {
        currency,
        subtotal: "subtotal" in selectedDocument.row ? Number(selectedDocument.row.subtotal || 0) : undefined,
        discount: "discount_amount" in selectedDocument.row ? Number(selectedDocument.row.discount_amount || 0) : undefined,
        shipping: "shipping_cost" in selectedDocument.row ? Number(selectedDocument.row.shipping_cost || 0) : undefined,
        total: Number(("sales_total" in selectedDocument.row ? selectedDocument.row.sales_total : selectedDocument.row.total_amount) || 0),
      },
      notes: selectedDocument.row.notes || "",
      totalQty: lines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
      totalWeight: (selectedDocument.row.lines || []).reduce((sum, line) => sum + Number(line.weight_kg || 0), 0),
    });

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
  }

  return (
    <div className="portal-shell">
      <div className="portal-header">
        <div className="portal-brand">
          {activeSnapshot.companyProfile?.logo_data_url ? <img src={activeSnapshot.companyProfile.logo_data_url} alt="Portal logo" className="portal-brand__logo" /> : null}
          <div>
            <h1>{activeSnapshot.companyProfile?.company_name || "Next Master Portal"}</h1>
            <p>
              {activeSnapshot.invite.party_type === "customer" ? "Customer Portal" : "Vendor Portal"} for {activeSnapshot.invite.party_name}
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
              <strong>{activeSnapshot.invite.party_name}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">Email</span>
              <strong>{activeSnapshot.invite.email}</strong>
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
              <strong>{formatMoney(activeSnapshot.accountSummary.totalAmount, activeSnapshot.accountSummary.currency)}</strong>
            </div>
            <div className="dashboard-stat">
              <span>Open Balance</span>
              <strong>{formatMoney(activeSnapshot.accountSummary.openAmount, activeSnapshot.accountSummary.currency)}</strong>
            </div>
            <div className="dashboard-stat">
              <span>Payments</span>
              <strong>{activeSnapshot.accountSummary.paymentCount}</strong>
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Document Filters">
        <div className="portal-filter-grid">
          <Input label="Search" value={documentSearch} placeholder="Document no, code, description" onChange={setDocumentSearch} />
          <Select label="Brand" value={brandFilter} options={brandOptions} onChange={setBrandFilter} />
        </div>
      </SectionCard>

      {activeSnapshot.invite.access.can_view_account ? (
        <SectionCard title="Account Statement">
          <DataTable rows={activeSnapshot.accountRows} columns={accountColumns} emptyText="No statement rows available." />
        </SectionCard>
      ) : null}

      {activeSnapshot.invite.party_type === "customer" && activeSnapshot.invite.access.can_view_orders ? (
        <SectionCard title="Sales Orders">
          <DataTable
            rows={filteredSalesOrders}
            columns={salesOrderColumns}
            emptyText="No sales orders available."
            onRowClick={(row) => setSelection({ kind: "sales-order", id: row.id })}
            rowClassName={(row) => (selection?.kind === "sales-order" && selection.id === row.id ? "data-table__row--active" : "")}
          />
        </SectionCard>
      ) : null}

      {activeSnapshot.invite.party_type === "customer" && activeSnapshot.invite.access.can_view_invoices ? (
        <SectionCard title="Invoices">
          <DataTable
            rows={filteredInvoices}
            columns={invoiceColumns}
            emptyText="No invoices available."
            onRowClick={(row) => setSelection({ kind: "invoice", id: row.id })}
            rowClassName={(row) => (selection?.kind === "invoice" && selection.id === row.id ? "data-table__row--active" : "")}
          />
        </SectionCard>
      ) : null}

      {activeSnapshot.invite.party_type === "vendor" && activeSnapshot.invite.access.can_view_orders ? (
        <SectionCard title="Purchase Orders">
          <DataTable
            rows={filteredPurchaseOrders}
            columns={purchaseOrderColumns}
            emptyText="No purchase orders available."
            onRowClick={(row) => setSelection({ kind: "purchase-order", id: row.id })}
            rowClassName={(row) => (selection?.kind === "purchase-order" && selection.id === row.id ? "data-table__row--active" : "")}
          />
        </SectionCard>
      ) : null}

      {activeSnapshot.invite.party_type === "vendor" && activeSnapshot.invite.access.can_view_invoices ? (
        <SectionCard title="Bills">
          <DataTable
            rows={filteredBills}
            columns={billColumns}
            emptyText="No bills available."
            onRowClick={(row) => setSelection({ kind: "bill", id: row.id })}
            rowClassName={(row) => (selection?.kind === "bill" && selection.id === row.id ? "data-table__row--active" : "")}
          />
        </SectionCard>
      ) : null}

      {selectedDocument ? (
        <SectionCard
          title={detailTitle}
          actions={
            <div className="inline-actions">
              <Button variant="secondary" onClick={handlePortalPrint}>
                PDF / Print
              </Button>
              <Button variant="secondary" onClick={() => setSelection(null)}>
                Close
              </Button>
            </div>
          }
        >
          <div className="portal-document-detail">
            <div className="portal-detail-grid">
              <div className="settings-item">
                <span className="settings-label">Status</span>
                <strong>{selectedDocument.row.status || "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Currency</span>
                <strong>{selectedDocument.row.currency || "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Date</span>
                <strong>
                  {formatDate(
                    selectedDocument.kind === "bill"
                      ? selectedDocument.row.bill_date
                      : "quote_date" in selectedDocument.row
                        ? selectedDocument.row.quote_date
                        : undefined,
                  )}
                </strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Due Date</span>
                <strong>{formatDate("due_date" in selectedDocument.row ? selectedDocument.row.due_date : undefined)}</strong>
              </div>
              {"delivery_term" in selectedDocument.row ? (
                <div className="settings-item">
                  <span className="settings-label">Delivery Term</span>
                  <strong>{selectedDocument.row.delivery_term || "-"}</strong>
                </div>
              ) : null}
              {"payment_terms" in selectedDocument.row ? (
                <div className="settings-item">
                  <span className="settings-label">Payment Terms</span>
                  <strong>{selectedDocument.row.payment_terms || "-"}</strong>
                </div>
              ) : null}
              {"contract_nr" in selectedDocument.row ? (
                <div className="settings-item">
                  <span className="settings-label">Contract Nr</span>
                  <strong>{selectedDocument.row.contract_nr || "-"}</strong>
                </div>
              ) : null}
              {"packing_details" in selectedDocument.row ? (
                <div className="settings-item">
                  <span className="settings-label">Packing</span>
                  <strong>{selectedDocument.row.packing_details || "-"}</strong>
                </div>
              ) : null}
            </div>

            {selectedDocument.row.notes ? (
              <div className="portal-detail-notes">
                <span className="settings-label">Notes</span>
                <strong>{selectedDocument.row.notes}</strong>
              </div>
            ) : null}

            <DataTable rows={selectedDocument.row.lines || []} columns={detailColumns} emptyText="No line details available." />

            <div className="portal-detail-totals">
              {"subtotal" in selectedDocument.row ? (
                <div className="settings-item">
                  <span className="settings-label">Sub Total</span>
                  <strong>{formatMoney(Number(selectedDocument.row.subtotal || 0), selectedDocument.row.currency)}</strong>
                </div>
              ) : null}
              {"discount_amount" in selectedDocument.row ? (
                <div className="settings-item">
                  <span className="settings-label">Discount</span>
                  <strong>{formatMoney(Number(selectedDocument.row.discount_amount || 0), selectedDocument.row.currency)}</strong>
                </div>
              ) : null}
              {"shipping_cost" in selectedDocument.row ? (
                <div className="settings-item">
                  <span className="settings-label">Shipping</span>
                  <strong>{formatMoney(Number(selectedDocument.row.shipping_cost || 0), selectedDocument.row.currency)}</strong>
                </div>
              ) : null}
              {"purchase_total" in selectedDocument.row && selectedDocument.kind !== "sales-order" && selectedDocument.kind !== "invoice" ? (
                <div className="settings-item">
                  <span className="settings-label">Purchase Total</span>
                  <strong>{formatMoney(Number(selectedDocument.row.purchase_total || 0), selectedDocument.row.currency)}</strong>
                </div>
              ) : null}
              <div className="settings-item">
                <span className="settings-label">Total Amount</span>
                <strong>{formatMoney(Number(("sales_total" in selectedDocument.row ? selectedDocument.row.sales_total : selectedDocument.row.total_amount) || 0), selectedDocument.row.currency)}</strong>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : null}

      {activeSnapshot.invite.access.can_view_payments ? (
        <SectionCard title="Payments">
          <DataTable
            rows={activeSnapshot.invite.party_type === "customer" ? activeSnapshot.paymentsReceived : activeSnapshot.paymentsMade}
            columns={paymentColumns}
            emptyText="No payments available."
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
