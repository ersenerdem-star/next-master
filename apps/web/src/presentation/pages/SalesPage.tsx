import { useEffect, useMemo, useState } from "react";
import { fetchCompanyProfiles, findCompanyProfileByName } from "../../infrastructure/api/companyProfilesApi";
import { fetchCustomers, findCustomerByNameInList } from "../../infrastructure/api/customersApi";
import { fetchInvoices, fetchPaymentsReceived, fetchSalesOrders, upsertInvoice, upsertPaymentReceived } from "../../infrastructure/api/ordersApi";
import { fetchPriceListSettings } from "../../infrastructure/api/priceListsApi";
import { QuotesPage } from "./QuotesPage";
import { PriceListsPage } from "./PriceListsPage";
import { SectionCard } from "../components/common/SectionCard";
import { buildInvoiceFromSalesOrder, buildMergedInvoiceFromSalesOrders } from "../../shared/localOrders";
import { resyncInvoiceLinesFromCatalog } from "../../shared/salesOrderCatalogSync";
import { DataTable } from "../components/common/DataTable";
import type { CompanyProfile } from "../../types/company";
import type { LocalCustomer } from "../../types/customers";
import type { LocalInvoice, LocalPaymentReceived, LocalSalesOrder } from "../../types/orders";
import { Button } from "../components/common/Button";
import { CustomersPage } from "./CustomersPage";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { buildBusinessDocumentHtml } from "../../shared/documentPrint";
import { BrandPill } from "../components/common/BrandPill";
import { buildEntityAlias } from "../../shared/entityAlias";

type SalesPageProps = {
  selectedSalesOrderId?: string;
  onSelectedSalesOrderChange?: (salesOrderId: string) => void;
  selectedQuoteId?: string;
  onSelectedQuoteChange?: (quoteId: string) => void;
  selectedInvoiceId?: string;
};

export function SalesPage({
  selectedSalesOrderId = "",
  onSelectedSalesOrderChange,
  selectedQuoteId = "",
  onSelectedQuoteChange,
  selectedInvoiceId: externalSelectedInvoiceId = "",
}: SalesPageProps) {
  const actionFeedback = useActionFeedback();
  const [activeTab, setActiveTab] = useState<"Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists">("Sales Orders");

  const tabs = ["Customers", "Sales Orders", "Invoices", "Payments Received", "Price Lists"] as const;
  const [invoices, setInvoices] = useState<LocalInvoice[]>([]);
  const [salesOrders, setSalesOrders] = useState<LocalSalesOrder[]>([]);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [invoiceDraft, setInvoiceDraft] = useState<LocalInvoice | null>(null);
  const [paymentsReceived, setPaymentsReceived] = useState<LocalPaymentReceived[]>([]);
  const [selectedPaymentReceivedId, setSelectedPaymentReceivedId] = useState("");
  const [paymentReceivedDraft, setPaymentReceivedDraft] = useState<LocalPaymentReceived | null>(null);
  const [selectedSalesOrderIds, setSelectedSalesOrderIds] = useState<string[]>([]);
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [marginA, setMarginA] = useState(10);
  const [marginB, setMarginB] = useState(15);
  const [invoiceResyncOnlyFillBlanks, setInvoiceResyncOnlyFillBlanks] = useState(true);
  const [invoiceResyncKeepPrices, setInvoiceResyncKeepPrices] = useState(true);
  const [resyncingInvoice, setResyncingInvoice] = useState(false);

  function renderInvoiceLifecycleBadge(row: { lifecycle_status?: string | null; lifecycle_warning?: string | null }) {
    if (String(row.lifecycle_status || "").trim().toLowerCase() !== "discontinued") return null;
    return (
      <div>
        <span className="mark-badge mark-badge--danger">Discontinued</span>
        {row.lifecycle_warning ? <div className="warning-text">{row.lifecycle_warning}</div> : null}
      </div>
    );
  }

  function cloneInvoice(input: LocalInvoice): LocalInvoice {
    return {
      ...input,
      lines: input.lines.map((line) => ({ ...line })),
    };
  }

  function recomputeInvoiceTotals(input: LocalInvoice): LocalInvoice {
    const lines = input.lines.map((line) => {
      const qty = Math.max(1, Number(line.qty || 1) || 1);
      const buyPrice = Number(line.buy_price || 0) || 0;
      const sellPrice = Number(line.sell_price || 0) || 0;
      const purchaseTotal = qty * buyPrice;
      const salesTotal = qty * sellPrice;
      const profitTotal = salesTotal - purchaseTotal;
      const marginPercent = salesTotal > 0 ? (profitTotal / salesTotal) * 100 : 0;
      return {
        ...line,
        qty,
        buy_price: buyPrice,
        sell_price: sellPrice,
        purchase_total: Math.round(purchaseTotal * 100) / 100,
        sales_total: Math.round(salesTotal * 100) / 100,
        profit_total: Math.round(profitTotal * 100) / 100,
        margin_percent: Math.round(marginPercent * 100) / 100,
      };
    });

    const subtotal = Math.round(lines.reduce((sum, line) => sum + Number(line.sales_total || 0), 0) * 100) / 100;
    const purchaseTotal = Math.round(lines.reduce((sum, line) => sum + Number(line.purchase_total || 0), 0) * 100) / 100;
    const totalAmount = Math.round((subtotal - Number(input.discount_amount || 0) + Number(input.shipping_cost || 0)) * 100) / 100;
    const profitTotal = Math.round((totalAmount - purchaseTotal) * 100) / 100;
    const marginPercent = totalAmount > 0 ? Math.round(((profitTotal / totalAmount) * 100) * 100) / 100 : 0;

    return {
      ...input,
      lines,
      subtotal,
      total_amount: totalAmount,
      purchase_total: purchaseTotal,
      profit_total: profitTotal,
      margin_percent: marginPercent,
    };
  }

  function buildInvoiceBrandSummary(lines: LocalInvoice["lines"]) {
    const labels: string[] = [];
    const seen = new Set<string>();

    lines.forEach((line) => {
      const brand = String(line.brand || "").trim();
      if (!brand) return;
      const key = brand.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      labels.push(brand);
    });

    return {
      labels: labels.slice(0, 3),
      extraCount: Math.max(0, labels.length - 3),
    };
  }

  useEffect(() => {
    if (!externalSelectedInvoiceId) return;
    setActiveTab("Invoices");
    setSelectedInvoiceId(externalSelectedInvoiceId);
  }, [externalSelectedInvoiceId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        if (activeTab === "Invoices") {
          const [invoiceRows, salesOrderRows] = await Promise.all([fetchInvoices(), fetchSalesOrders()]);
          if (cancelled) return;
          setInvoices(invoiceRows);
          setSalesOrders(salesOrderRows);
          return;
        }

        if (activeTab === "Payments Received") {
          const [paymentRows, invoiceRows] = await Promise.all([fetchPaymentsReceived(), fetchInvoices()]);
          if (cancelled) return;
          setPaymentsReceived(paymentRows);
          setInvoices(invoiceRows);
        }
      } catch {
        if (!cancelled) {
          if (activeTab === "Invoices") {
            setInvoices([]);
            setSalesOrders([]);
          }
          if (activeTab === "Payments Received") {
            setPaymentsReceived([]);
            setInvoices([]);
          }
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const needsReferenceData = activeTab === "Invoices" || activeTab === "Payments Received";
      if (!needsReferenceData) return;
      try {
        const [customerRows, companyRows] = await Promise.all([fetchCustomers(), fetchCompanyProfiles()]);
        if (cancelled) return;
        setCustomers(customerRows);
        setCompanyProfiles(companyRows);
      } catch {
        if (!cancelled) {
          setCustomers([]);
          setCompanyProfiles([]);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const settings = await fetchPriceListSettings();
        if (cancelled) return;
        const nextA = settings.find((item) => item.listType === "A")?.marginPercent;
        const nextB = settings.find((item) => item.listType === "B")?.marginPercent;
        if (typeof nextA === "number") setMarginA(nextA);
        if (typeof nextB === "number") setMarginB(nextB);
      } catch {
        // defaults remain
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!invoices.length) {
      setSelectedInvoiceId("");
      setInvoiceDraft(null);
      return;
    }
    const current = invoices.find((item) => item.id === selectedInvoiceId) || invoices[0];
    setSelectedInvoiceId(current.id);
    setInvoiceDraft(cloneInvoice(current));
  }, [invoices, selectedInvoiceId]);

  useEffect(() => {
    if (!paymentsReceived.length) {
      const next = createEmptyPaymentReceived();
      setSelectedPaymentReceivedId(next.id);
      setPaymentReceivedDraft(next);
      return;
    }
    const current = paymentsReceived.find((item) => item.id === selectedPaymentReceivedId) || paymentsReceived[0];
    setSelectedPaymentReceivedId(current.id);
    setPaymentReceivedDraft({ ...current });
  }, [paymentsReceived, selectedPaymentReceivedId]);

  function formatMoney(value: number, currency = "EUR") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(value || 0));
  }

  function safeText(value: unknown) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function safeMultiline(value: unknown) {
    return safeText(value).replaceAll("\n", "<br />");
  }

  function createEmptyPaymentReceived(invoice?: LocalInvoice | null): LocalPaymentReceived {
    const now = new Date().toISOString();
    return {
      id: `PR-${Date.now()}`,
      invoice_id: invoice?.id || "",
      invoice_no: invoice?.id || "",
      customer_name: invoice?.customer_name || "",
      currency: invoice?.currency || "EUR",
      received_date: now.slice(0, 10),
      amount: Number(invoice?.total_amount || 0) || 0,
      method: "Bank Transfer",
      reference_no: "",
      notes: "",
      status: "draft",
      created_at: now,
      updated_at: now,
    };
  }

  function buildCustomerAddressBlock(row: LocalInvoice) {
    const customer = findCustomerByNameInList(customers, row.customer_name);
    if (!customer) return row.customer_name || "-";
    const displayName = customer.display_name || customer.company_name || row.customer_name || "-";
    return [displayName, customer.billing_address || "", customer.company_id ? `Company ID ${customer.company_id}` : "", customer.work_phone ? `Phone: ${customer.work_phone}` : "", customer.email || ""]
      .filter(Boolean)
      .join("\n");
  }

  function buildCustomerShippingBlock(row: LocalInvoice) {
    const customer = findCustomerByNameInList(customers, row.customer_name);
    if (!customer) return row.customer_name || "-";
    const displayName = customer.display_name || customer.company_name || row.customer_name || "-";
    return [displayName, customer.shipping_address || customer.billing_address || "", customer.company_id ? `Company ID ${customer.company_id}` : "", customer.mobile_phone ? `Phone: ${customer.mobile_phone}` : customer.work_phone ? `Phone: ${customer.work_phone}` : "", customer.email || ""]
      .filter(Boolean)
      .join("\n");
  }

  function buildInvoiceHtml(row: LocalInvoice) {
    const company =
      findCompanyProfileByName(companyProfiles, row.seller_company) || {
        id: "",
        companyName: row.seller_company || "Company",
        email: "",
        phone: "",
        website: "",
        address: "",
        bankDetails: "",
        taxOffice: "",
        taxNumber: "",
        footerNote: "",
        logoDataUrl: "",
      };
    const currency = row.currency || "EUR";
    const logo = company.logoDataUrl ? `<img src="${company.logoDataUrl}" alt="Logo" style="max-height:72px; max-width:180px; object-fit:contain;" />` : "";
    const sellerAddressLine = [company.address || "", company.taxNumber ? `Tax ID: ${company.taxNumber}` : ""].filter(Boolean).join("   ");
    const sellerBankDetails = company.bankDetails || "";
    const billingBlock = buildCustomerAddressBlock(row);
    const shippingBlock = buildCustomerShippingBlock(row);
    const showShipping = shippingBlock !== billingBlock;
    const totalQty = row.lines.reduce((sum, line) => sum + line.qty, 0);
    const totalWeight = row.lines.reduce((sum, line) => sum + (Number(line.weight_kg ?? 0) || 0) * line.qty, 0);
    return buildBusinessDocumentHtml({
      docType: "Invoice",
      docNo: row.id,
      company: {
        companyName: company.companyName || "",
        address: company.address || "",
        bankDetails: company.bankDetails || "",
        taxNumber: company.taxNumber || "",
        logoDataUrl: company.logoDataUrl || "",
      },
      party: {
        title: "Bill To",
        details: billingBlock,
        shippingTitle: showShipping ? "Shipping Address" : undefined,
        shippingDetails: showShipping ? shippingBlock : undefined,
      },
      meta: [
        { label: "Invoice Date", value: row.quote_date || "-" },
        { label: "Terms", value: row.payment_terms || "-" },
        { label: "Due Date", value: row.due_date || "-" },
        { label: "Delivery Term", value: row.delivery_term || "-" },
        { label: "Contract Nr", value: row.contract_nr || "-" },
        { label: "Sales Order", value: row.sales_order_no || "-" },
      ],
      lines: row.lines.map((line) => ({
        code: line.product_code,
        description: line.description || "",
        origin: line.origin || "",
        brand: line.brand || "",
        orderNo: row.sales_order_no || "",
        weight: line.weight_kg == null ? "" : String(line.weight_kg),
        gtip: line.hs_code || "",
        qty: line.qty,
        unitPrice: Number(line.sell_price || 0) || 0,
        amount: Number(line.sales_total || 0) || 0,
      })),
      totals: {
        currency,
        subtotal: Number(row.subtotal || 0) || 0,
        discount: Number(row.discount_amount || 0) || 0,
        shipping: Number(row.shipping_cost || 0) || 0,
        total: Number(row.total_amount || 0) || 0,
      },
      notes: row.notes || "",
      totalQty,
      totalWeight,
    });
  }

  function handlePrintInvoice(row: LocalInvoice) {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      actionFeedback.fail("Popup blocked while opening invoice view.");
      return;
    }
    win.document.write(buildInvoiceHtml(row));
    win.document.close();
    win.focus();
    actionFeedback.succeed("Invoice PDF view opened.");
  }

  const selectedInvoice = useMemo(() => invoices.find((item) => item.id === selectedInvoiceId) || null, [invoices, selectedInvoiceId]);
  const invoiceDiscontinuedLineCount = useMemo(
    () => invoiceDraft?.lines.filter((line) => line.lifecycle_status === "discontinued").length || 0,
    [invoiceDraft],
  );

  function updateInvoiceDraft<K extends keyof LocalInvoice>(key: K, value: LocalInvoice[K]) {
    setInvoiceDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function handleResyncInvoiceFromCatalog() {
    if (!invoiceDraft) return;
    try {
      setResyncingInvoice(true);
      actionFeedback.begin(`Re-syncing invoice ${invoiceDraft.id} from catalog...`);
      const salesOrderCustomerType = salesOrders.find((row) => row.id === invoiceDraft.sales_order_id)?.customer_type || "A";
      const nextLines = await resyncInvoiceLinesFromCatalog(invoiceDraft.lines, {
        customerType: salesOrderCustomerType,
        marginA,
        marginB,
        onlyFillBlanks: invoiceResyncOnlyFillBlanks,
        keepPrices: invoiceResyncKeepPrices,
      });
      const nextDraft = recomputeInvoiceTotals({
        ...invoiceDraft,
        lines: nextLines,
      });
      const saved = await upsertInvoice(nextDraft, selectedInvoiceId);
      const refreshed = await fetchInvoices();
      setInvoices(refreshed);
      setSelectedInvoiceId(saved.id);
      setInvoiceDraft(cloneInvoice(saved));
      actionFeedback.succeed("Invoice re-synced from catalog.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Invoice catalog re-sync failed");
    } finally {
      setResyncingInvoice(false);
    }
  }

  async function saveInvoiceDraft() {
    if (!invoiceDraft) return;
    const previousId = selectedInvoiceId;
    const payload: LocalInvoice = {
      ...recomputeInvoiceTotals(invoiceDraft),
      discount_amount: Number(invoiceDraft.discount_amount || 0),
      shipping_cost: Number(invoiceDraft.shipping_cost || 0),
      updated_at: new Date().toISOString(),
    };
    try {
      actionFeedback.begin(`Saving invoice ${payload.id}...`);
      const saved = await upsertInvoice(payload, previousId);
      const next = [saved, ...invoices.filter((item) => item.id !== previousId && item.id !== saved.id)].sort((a, b) =>
        String(b.updated_at).localeCompare(String(a.updated_at)),
      );
      setInvoices(next);
      setSelectedInvoiceId(saved.id);
      setInvoiceDraft(cloneInvoice(saved));
      actionFeedback.succeed(`Invoice ${saved.id} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Invoice save failed");
    }
  }

  async function savePaymentReceivedDraft() {
    if (!paymentReceivedDraft) return;
    const previousId = selectedPaymentReceivedId;
    const payload: LocalPaymentReceived = {
      ...paymentReceivedDraft,
      amount: Number(paymentReceivedDraft.amount || 0),
      updated_at: new Date().toISOString(),
    };
    try {
      actionFeedback.begin(`Saving payment ${payload.id}...`);
      const saved = await upsertPaymentReceived(payload, previousId);
      const [refreshedPayments, refreshedInvoices] = await Promise.all([fetchPaymentsReceived(), fetchInvoices()]);
      setPaymentsReceived(refreshedPayments);
      setInvoices(refreshedInvoices);
      setSelectedPaymentReceivedId(saved.id);
      setPaymentReceivedDraft({ ...saved });
      actionFeedback.succeed(`Payment ${saved.id} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Payment save failed");
    }
  }

  function handleAddPaymentReceived(invoice?: LocalInvoice | null) {
    const next = createEmptyPaymentReceived(invoice || selectedInvoice || null);
    setSelectedPaymentReceivedId(next.id);
    setPaymentReceivedDraft(next);
    setActiveTab("Payments Received");
    actionFeedback.succeed("New payment draft ready.");
  }

  const invoiceReadyOrders = useMemo(
    () =>
      salesOrders.filter((order) => {
        if (order.status !== "confirmed") return false;
        return !invoices.some((invoice) => invoice.sales_order_id === order.id || invoice.sales_order_ids?.includes(order.id));
      }),
    [salesOrders, invoices],
  );

  async function handleCreateInvoicesFromSelection() {
    if (!selectedSalesOrderIds.length) {
      actionFeedback.fail("Select confirmed sales orders first.");
      return;
    }
    try {
      actionFeedback.begin(`Creating ${selectedSalesOrderIds.length.toLocaleString("en-US")} invoice(s)...`);
      const created = await Promise.all(
        salesOrders
          .filter((order) => selectedSalesOrderIds.includes(order.id))
          .map((order) => upsertInvoice(buildInvoiceFromSalesOrder(order))),
      );
      const refreshed = await fetchInvoices();
      setInvoices(refreshed);
      setSelectedSalesOrderIds([]);
      if (created[0]) {
        setSelectedInvoiceId(created[0].id);
        setInvoiceDraft(cloneInvoice(created[0]));
      }
      actionFeedback.succeed(`${created.length.toLocaleString("en-US")} invoice(s) created.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Invoice create failed");
    }
  }

  async function handleMergeInvoicesFromSelection() {
    if (!selectedSalesOrderIds.length) {
      actionFeedback.fail("Select confirmed sales orders first.");
      return;
    }

    const selectedOrders = salesOrders.filter((order) => selectedSalesOrderIds.includes(order.id));
    if (!selectedOrders.length) {
      actionFeedback.fail("Selected sales orders could not be resolved.");
      return;
    }

    const first = selectedOrders[0];
    const incompatible = selectedOrders.find(
      (order) =>
        order.customer_name !== first.customer_name ||
        order.currency !== first.currency ||
        order.seller_company !== first.seller_company,
    );
    if (incompatible) {
      actionFeedback.fail("Merged invoice requires same customer, same currency, and same seller company.");
      return;
    }

    try {
      actionFeedback.begin(`Merging ${selectedOrders.length.toLocaleString("en-US")} sales order(s) into one invoice...`);
      const merged = await upsertInvoice(buildMergedInvoiceFromSalesOrders(selectedOrders));
      const refreshed = await fetchInvoices();
      setInvoices(refreshed);
      setSelectedSalesOrderIds([]);
      setSelectedInvoiceId(merged.id);
      setInvoiceDraft(cloneInvoice(merged));
      actionFeedback.succeed(`Merged invoice ${merged.id} created from ${selectedOrders.length.toLocaleString("en-US")} sales order(s).`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Merged invoice create failed");
    }
  }

  const invoiceColumns = [
    { key: "invoice", header: "Invoice No", render: (row: LocalInvoice) => row.id },
    { key: "salesOrder", header: "Sales Order", render: (row: LocalInvoice) => row.sales_order_no },
    {
      key: "brands",
      header: "Brand",
      render: (row: LocalInvoice) => {
        const brandSummary = buildInvoiceBrandSummary(row.lines);
        if (!brandSummary.labels.length) return "-";
        return (
          <span className="document-marks document-marks--compact">
            {brandSummary.labels.map((brand) => (
              <BrandPill key={`${row.id}-${brand}`} brand={brand} compact />
            ))}
            {brandSummary.extraCount > 0 ? <span className="mark-badge mark-badge--info">+{brandSummary.extraCount}</span> : null}
          </span>
        );
      },
    },
    {
      key: "customer",
      header: "Customer",
      render: (row: LocalInvoice) => <span title={row.customer_name || "-"}>{buildEntityAlias(row.customer_name)}</span>,
    },
    {
      key: "seller",
      header: "Seller Company",
      render: (row: LocalInvoice) => <span title={row.seller_company || "-"}>{buildEntityAlias(row.seller_company)}</span>,
    },
    { key: "date", header: "Date", render: (row: LocalInvoice) => row.quote_date || "-" },
    { key: "amount", header: "Total Amount", render: (row: LocalInvoice) => `${row.total_amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
    { key: "profit", header: "Profit", render: (row: LocalInvoice) => `${row.profit_total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
    { key: "margin", header: "Margin %", render: (row: LocalInvoice) => `${row.margin_percent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%` },
    { key: "status", header: "Status", render: (row: LocalInvoice) => row.status },
    {
      key: "actions",
      header: "Actions",
      render: (row: LocalInvoice) => (
        <Button variant="secondary" className="button--compact" onClick={() => handlePrintInvoice(row)}>
          PDF / Print
        </Button>
      ),
    },
  ];

  const paymentReceivedColumns = [
    { key: "payment", header: "Payment No", render: (row: LocalPaymentReceived) => row.id },
    { key: "invoice", header: "Invoice", render: (row: LocalPaymentReceived) => row.invoice_no || "-" },
    { key: "customer", header: "Customer", render: (row: LocalPaymentReceived) => row.customer_name || "-" },
    { key: "date", header: "Date", render: (row: LocalPaymentReceived) => row.received_date || "-" },
    { key: "method", header: "Method", render: (row: LocalPaymentReceived) => row.method || "-" },
    { key: "reference", header: "Reference", render: (row: LocalPaymentReceived) => row.reference_no || "-" },
    { key: "amount", header: "Amount", render: (row: LocalPaymentReceived) => formatMoney(row.amount, row.currency) },
    { key: "status", header: "Status", render: (row: LocalPaymentReceived) => row.status },
  ];

  return (
    <div className="page-stack">
      <div className="module-tabs">
        {tabs.map((item) => (
          <button key={item} className={`module-tab${activeTab === item ? " active" : ""}`} onClick={() => setActiveTab(item)}>
            {item}
          </button>
        ))}
      </div>

      {activeTab === "Sales Orders" ? (
        <QuotesPage
          selectedSalesOrderId={selectedSalesOrderId}
          onSelectedSalesOrderChange={onSelectedSalesOrderChange}
          selectedQuoteId={selectedQuoteId}
          onSelectedQuoteChange={onSelectedQuoteChange}
        />
      ) : null}
      {activeTab === "Price Lists" ? <PriceListsPage /> : null}
      {activeTab === "Customers" ? <CustomersPage /> : null}
      {activeTab === "Invoices" ? (
        <SectionCard title="Invoices">
          {invoiceReadyOrders.length ? (
            <div className="invoice-bulk-panel">
              <strong>Convert Confirmed Sales Orders</strong>
              <div className="invoice-bulk-list">
                {invoiceReadyOrders.map((order) => (
                  <label key={order.id} className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={selectedSalesOrderIds.includes(order.id)}
                      onChange={(event) =>
                        setSelectedSalesOrderIds((current) =>
                          event.target.checked ? [...current, order.id] : current.filter((item) => item !== order.id),
                        )
                      }
                    />
                    <span className="field__label">{order.sales_order_no} - {order.customer_name}</span>
                  </label>
                ))}
              </div>
              <div className="toolbar toolbar--wrap">
                <Button onClick={handleCreateInvoicesFromSelection}>Create Invoice(s)</Button>
                <Button variant="secondary" onClick={handleMergeInvoicesFromSelection}>
                  Merge Into One Invoice
                </Button>
                <Button variant="secondary" onClick={() => handleAddPaymentReceived()}>
                  + Add Payment Received
                </Button>
              </div>
            </div>
          ) : null}
          <div className="meta-row">
            <span>{invoices.length.toLocaleString("en-US")} invoices loaded</span>
            <span>Created from confirmed sales orders after purchase orders are generated.</span>
          </div>
          <DataTable
            rows={invoices}
            columns={invoiceColumns}
            emptyText="No invoices yet. Confirm a sales order and convert it to invoice."
            onRowClick={(row) => {
              setSelectedInvoiceId(row.id);
              setInvoiceDraft(cloneInvoice(row));
            }}
            rowClassName={(row) => (row.id === selectedInvoiceId ? "data-table__row--active" : "")}
          />
          {selectedInvoice && invoiceDraft ? (
            <div className="invoice-editor-block">
              <div className="invoice-edit-shell">
                <div className="invoice-meta-grid">
                  <Input label="Invoice No" value={invoiceDraft.id} onChange={(value) => updateInvoiceDraft("id", value)} />
                  <Input label="Sales Order" value={invoiceDraft.sales_order_no} onChange={(value) => updateInvoiceDraft("sales_order_no", value)} />
                  <Input label="Customer" value={invoiceDraft.customer_name} onChange={(value) => updateInvoiceDraft("customer_name", value)} />
                  <Input label="Invoice Date" type="date" value={invoiceDraft.quote_date} onChange={(value) => updateInvoiceDraft("quote_date", value)} />
                  <Input label="Due Date" type="date" value={invoiceDraft.due_date} onChange={(value) => updateInvoiceDraft("due_date", value)} />
                  <Select
                    label="Status"
                    value={invoiceDraft.status}
                    options={[
                      { value: "draft", label: "Draft" },
                      { value: "confirmed", label: "Confirmed" },
                      { value: "paid", label: "Paid" },
                      { value: "void", label: "Void" },
                    ]}
                    onChange={(value) => updateInvoiceDraft("status", value as LocalInvoice["status"])}
                  />
                  <Select
                    label="Terms"
                    value={invoiceDraft.payment_terms}
                    options={[
                      { value: "Cash in Advance", label: "Cash in Advance" },
                      { value: "Due on Receipt", label: "Due on Receipt" },
                      { value: "Net 7", label: "Net 7" },
                      { value: "Net 15", label: "Net 15" },
                      { value: "Net 30", label: "Net 30" },
                      { value: "Net 45", label: "Net 45" },
                      { value: "Net 60", label: "Net 60" },
                    ]}
                    onChange={(value) => updateInvoiceDraft("payment_terms", value)}
                  />
                  <Input label="Contract Nr" value={invoiceDraft.contract_nr} onChange={(value) => updateInvoiceDraft("contract_nr", value)} />
                  <Input label="Packing Details" value={invoiceDraft.packing_details} onChange={(value) => updateInvoiceDraft("packing_details", value)} />
                  <Input label="Discount" type="number" value={String(invoiceDraft.discount_amount)} onChange={(value) => setInvoiceDraft((current) => (current ? recomputeInvoiceTotals({ ...current, discount_amount: Number(value || 0) }) : current))} />
                  <Input label="Shipping Handling" type="number" value={String(invoiceDraft.shipping_cost)} onChange={(value) => setInvoiceDraft((current) => (current ? recomputeInvoiceTotals({ ...current, shipping_cost: Number(value || 0) }) : current))} />
                  <Input label="Sub Total" type="number" value={String(invoiceDraft.subtotal)} onChange={() => undefined} disabled />
                  <Input label="Currency" value={invoiceDraft.currency} onChange={(value) => updateInvoiceDraft("currency", value)} />
                </div>
                <table className="simple-edit-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Buy</th>
                      <th>Sell</th>
                      <th>Line Total</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiceDraft.lines.map((line, index) => (
                      <tr key={`${line.product_code}-${index}`}>
                        <td>{line.product_code}</td>
                        <td>
                          <div>{line.description || "-"}</div>
                          {renderInvoiceLifecycleBadge(line)}
                        </td>
                        <td>
                          <input
                            className="inline-edit-input inline-edit-input--qty"
                            type="number"
                            min={1}
                            step={1}
                            value={line.qty}
                            onChange={(event) =>
                              setInvoiceDraft((current) =>
                                current
                                  ? recomputeInvoiceTotals({
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, qty: Math.max(1, Number(event.target.value || 1) || 1) } : item,
                                      ),
                                    })
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="inline-edit-input inline-edit-input--money"
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.buy_price}
                            onChange={(event) =>
                              setInvoiceDraft((current) =>
                                current
                                  ? recomputeInvoiceTotals({
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, buy_price: Number(event.target.value || 0) } : item,
                                      ),
                                    })
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>
                          <input
                            className="inline-edit-input inline-edit-input--money"
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.sell_price}
                            onChange={(event) =>
                              setInvoiceDraft((current) =>
                                current
                                  ? recomputeInvoiceTotals({
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, sell_price: Number(event.target.value || 0) } : item,
                                      ),
                                    })
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>{formatMoney(Number(line.sales_total || 0), invoiceDraft.currency)}</td>
                        <td>
                          <input
                            className="inline-edit-input"
                            value={line.notes}
                            onChange={(event) =>
                              setInvoiceDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, notes: event.target.value } : item,
                                      ),
                                    }
                                  : current,
                              )
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {invoiceDiscontinuedLineCount > 0 ? (
                  <div className="warning-text">
                    {invoiceDiscontinuedLineCount.toLocaleString("en-US")} discontinued item(s) detected in this invoice. Review before confirmation or sending.
                  </div>
                ) : null}
                <div className="quote-summary-card">
                  <div className="quote-summary-row">
                    <span>Sub Total</span>
                    <strong>{formatMoney(invoiceDraft.subtotal, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-row">
                    <span>Discount</span>
                    <strong>{formatMoney(invoiceDraft.discount_amount, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-row">
                    <span>Shipping Handling</span>
                    <strong>{formatMoney(invoiceDraft.shipping_cost, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-row quote-summary-row--total">
                    <span>Total Amount</span>
                    <strong>{formatMoney(invoiceDraft.total_amount, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-internal">
                    <div className="quote-summary-mini">
                      <span>Purchase Total</span>
                      <strong>{formatMoney(invoiceDraft.purchase_total, invoiceDraft.currency)}</strong>
                    </div>
                    <div className="quote-summary-mini">
                      <span>Profit</span>
                      <strong>{formatMoney(invoiceDraft.profit_total, invoiceDraft.currency)}</strong>
                    </div>
                    <div className="quote-summary-mini">
                      <span>Margin %</span>
                      <strong>{invoiceDraft.margin_percent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</strong>
                    </div>
                  </div>
                </div>
                <div className="field field--full">
                  <label className="field__label">Notes</label>
                  <textarea className="field__input field__input--textarea" value={invoiceDraft.notes} onChange={(event) => updateInvoiceDraft("notes", event.target.value)} />
                </div>
                <div className="toolbar toolbar--wrap">
                  <label className="checkbox-field quote-toolbar-checkbox">
                    <input type="checkbox" checked={invoiceResyncOnlyFillBlanks} onChange={(event) => setInvoiceResyncOnlyFillBlanks(event.target.checked)} />
                    <span className="field__label">Only Fill Blanks</span>
                  </label>
                  <label className="checkbox-field quote-toolbar-checkbox">
                    <input type="checkbox" checked={invoiceResyncKeepPrices} onChange={(event) => setInvoiceResyncKeepPrices(event.target.checked)} />
                    <span className="field__label">Keep Prices</span>
                  </label>
                  <Button variant="secondary" onClick={() => void handleResyncInvoiceFromCatalog()} busy={resyncingInvoice} busyLabel="Re-syncing...">
                    Re-sync from Catalog
                  </Button>
                  <Button onClick={saveInvoiceDraft}>Save Invoice</Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setInvoiceDraft((current) => (current ? { ...current, status: "confirmed" } : current));
                    }}
                  >
                    Mark Confirmed
                  </Button>
                  <Button variant="secondary" onClick={() => handlePrintInvoice(invoiceDraft)}>
                    PDF / Print
                  </Button>
                  <Button variant="secondary" onClick={() => handleAddPaymentReceived(invoiceDraft)}>
                    Add Payment
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
      {activeTab === "Payments Received" ? (
        <SectionCard title="Payments Received">
          <div className="meta-row">
            <span>{paymentsReceived.length.toLocaleString("en-US")} payments loaded</span>
            <span>Record collections and tie them to invoices.</span>
          </div>
          <div className="toolbar toolbar--wrap">
            <Button onClick={() => handleAddPaymentReceived()}>+ Add Payment Received</Button>
          </div>
          <DataTable
            rows={paymentsReceived}
            columns={paymentReceivedColumns}
            emptyText="No received payments yet."
            onRowClick={(row) => {
              setSelectedPaymentReceivedId(row.id);
              setPaymentReceivedDraft({ ...row });
            }}
            rowClassName={(row) => (row.id === selectedPaymentReceivedId ? "data-table__row--active" : "")}
          />
          {paymentReceivedDraft ? (
            <div className="invoice-editor-block">
              <div className="invoice-edit-shell">
                <div className="invoice-meta-grid">
                  <Input label="Payment No" value={paymentReceivedDraft.id} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, id: value } : current))} />
                  <label className="field">
                    <span className="field__label">Invoice</span>
                    <select
                      className="field__input"
                      value={paymentReceivedDraft.invoice_id}
                      onChange={(event) => {
                        const invoice = invoices.find((item) => item.id === event.target.value) || null;
                        setPaymentReceivedDraft((current) =>
                          current
                            ? {
                                ...current,
                                invoice_id: invoice?.id || "",
                                invoice_no: invoice?.id || "",
                                customer_name: invoice?.customer_name || current.customer_name,
                                currency: invoice?.currency || current.currency,
                                amount: invoice ? Number(invoice.total_amount || 0) : current.amount,
                              }
                            : current,
                        );
                      }}
                    >
                      <option value="">Manual / Unlinked</option>
                      {invoices.map((invoice) => (
                        <option key={invoice.id} value={invoice.id}>
                          {invoice.id} - {invoice.customer_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Input label="Invoice No" value={paymentReceivedDraft.invoice_no} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, invoice_no: value } : current))} />
                  <Input label="Customer" value={paymentReceivedDraft.customer_name} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, customer_name: value } : current))} />
                  <Input label="Received Date" type="date" value={paymentReceivedDraft.received_date} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, received_date: value } : current))} />
                  <Input label="Amount" type="number" value={String(paymentReceivedDraft.amount)} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, amount: Number(value || 0) } : current))} />
                  <Select
                    label="Method"
                    value={paymentReceivedDraft.method}
                    options={[
                      { value: "Bank Transfer", label: "Bank Transfer" },
                      { value: "Cash", label: "Cash" },
                      { value: "Credit Card", label: "Credit Card" },
                      { value: "Cheque", label: "Cheque" },
                    ]}
                    onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, method: value } : current))}
                  />
                  <Input label="Reference No" value={paymentReceivedDraft.reference_no} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, reference_no: value } : current))} />
                  <Select
                    label="Status"
                    value={paymentReceivedDraft.status}
                    options={[
                      { value: "draft", label: "Draft" },
                      { value: "confirmed", label: "Confirmed" },
                      { value: "void", label: "Void" },
                    ]}
                    onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, status: value as LocalPaymentReceived["status"] } : current))}
                  />
                  <Input label="Currency" value={paymentReceivedDraft.currency} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, currency: value } : current))} />
                </div>
                <div className="field field--full">
                  <label className="field__label">Notes</label>
                  <textarea className="field__input field__input--textarea" value={paymentReceivedDraft.notes} onChange={(event) => setPaymentReceivedDraft((current) => (current ? { ...current, notes: event.target.value } : current))} />
                </div>
                <div className="toolbar toolbar--wrap">
                  <Button onClick={savePaymentReceivedDraft}>Save Payment</Button>
                  <Button variant="secondary" onClick={() => setPaymentReceivedDraft((current) => (current ? { ...current, status: "confirmed" } : current))}>
                    Mark Confirmed
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
