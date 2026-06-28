import { useEffect, useMemo, useState } from "react";
import { fetchCompanyProfiles, findCompanyProfileByName } from "../../infrastructure/api/companyProfilesApi";
import { fetchCustomers, findCustomerByNameInList } from "../../infrastructure/api/customersApi";
import {
  deleteInvoice,
  deletePaymentReceived,
  fetchInvoiceById,
  fetchInvoiceSummaries,
  fetchPaymentsReceived,
  fetchSalesOrderById,
  fetchSalesOrderSummaries,
  upsertInvoice,
  upsertPaymentReceived,
} from "../../infrastructure/api/ordersApi";
import { fetchPriceListSettings } from "../../infrastructure/api/priceListsApi";
import { fetchWarehouses } from "../../infrastructure/api/warehousesApi";
import { QuotesPage } from "./QuotesPage";
import { PriceListsPage } from "./PriceListsPage";
import { SectionCard } from "../components/common/SectionCard";
import { buildInvoiceFromSalesOrder, buildMergedInvoiceFromSalesOrders } from "../../shared/localOrders";
import { resyncInvoiceLinesFromCatalog } from "../../shared/salesOrderCatalogSync";
import { DataTable } from "../components/common/DataTable";
import type { CompanyProfile } from "../../types/company";
import type { LocalCustomer } from "../../types/customers";
import type { LocalInvoice, LocalPaymentReceived, LocalSalesOrder } from "../../types/orders";
import type { Warehouse } from "../../types/warehouses";
import { Button } from "../components/common/Button";
import { CustomersPage } from "./CustomersPage";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { useI18n } from "../../i18n/I18nProvider";
import { buildBusinessDocumentHtml, openBusinessDocumentPreview } from "../../shared/documentPrint";
import { BrandPill } from "../components/common/BrandPill";
import { buildEntityAlias } from "../../shared/entityAlias";

type SalesPageProps = {
  activeTab?: "Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists";
  salesOrdersNavTick?: number;
  invoicesNavTick?: number;
  selectedSalesOrderId?: string;
  onSelectedSalesOrderChange?: (salesOrderId: string) => void;
  selectedQuoteId?: string;
  onSelectedQuoteChange?: (quoteId: string) => void;
  selectedInvoiceId?: string;
  onSelectedInvoiceChange?: (invoiceId: string) => void;
};

export function SalesPage({
  activeTab: activeTabProp = "Sales Orders",
  salesOrdersNavTick = 0,
  invoicesNavTick = 0,
  selectedSalesOrderId = "",
  onSelectedSalesOrderChange,
  selectedQuoteId = "",
  onSelectedQuoteChange,
  selectedInvoiceId: externalSelectedInvoiceId = "",
  onSelectedInvoiceChange,
}: SalesPageProps) {
  const { t } = useI18n();
  const actionFeedback = useActionFeedback();
  const [activeTab, setActiveTab] = useState<"Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists">(activeTabProp);
  const [invoicesView, setInvoicesView] = useState<"list" | "detail">(externalSelectedInvoiceId ? "detail" : "list");
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
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [marginA, setMarginA] = useState(10);
  const [marginB, setMarginB] = useState(15);
  const [invoiceResyncOnlyFillBlanks, setInvoiceResyncOnlyFillBlanks] = useState(true);
  const [invoiceResyncKeepPrices, setInvoiceResyncKeepPrices] = useState(true);
  const [resyncingInvoice, setResyncingInvoice] = useState(false);

  function renderInvoiceLifecycleBadge(row: { lifecycle_status?: string | null; lifecycle_warning?: string | null }) {
    if (String(row.lifecycle_status || "").trim().toLowerCase() !== "discontinued") return null;
    return (
      <div>
        <span className="mark-badge mark-badge--danger">{t("sales.warnings.discontinued")}</span>
        {row.lifecycle_warning ? <div className="warning-text">{row.lifecycle_warning}</div> : null}
      </div>
    );
  }

  function compactWarningText(value: string | null | undefined) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function buildInvoicePrintAlerts(line: LocalInvoice["lines"][number]) {
    const alerts: Array<{ text: string; tone?: "warning" | "danger" | "muted" }> = [];
    const oldCode = String(line.old_code || "").trim();
    const productCode = String(line.product_code || "").trim();
    if (oldCode && oldCode !== productCode) {
      alerts.push({ text: `Changed No: ${oldCode} -> ${productCode}.`, tone: "warning" });
    }
    const lifecycleWarning = compactWarningText(line.lifecycle_warning);
    if (line.lifecycle_status === "discontinued") {
      alerts.push({
        text: lifecycleWarning || `Discontinued item: ${productCode || oldCode || "this item"}.`,
        tone: "danger",
      });
    } else if (lifecycleWarning) {
      alerts.push({ text: lifecycleWarning, tone: "muted" });
    }
    return alerts;
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
    setActiveTab(activeTabProp);
  }, [activeTabProp]);

  useEffect(() => {
    if (!externalSelectedInvoiceId) return;
    setActiveTab("Invoices");
    setSelectedInvoiceId(externalSelectedInvoiceId);
    setInvoicesView("detail");
  }, [externalSelectedInvoiceId]);

  useEffect(() => {
    if (!invoicesNavTick) return;
    if (activeTabProp !== "Invoices") return;
    if (externalSelectedInvoiceId) return;
    setInvoicesView("list");
  }, [invoicesNavTick, activeTabProp, externalSelectedInvoiceId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        if (activeTab === "Invoices") {
          const [invoiceRows, salesOrderRows] = await Promise.all([fetchInvoiceSummaries(), fetchSalesOrderSummaries()]);
          if (cancelled) return;
          setInvoices(invoiceRows);
          setSalesOrders(salesOrderRows);
          return;
        }

        if (activeTab === "Payments Received") {
          const [paymentRows, invoiceRows] = await Promise.all([fetchPaymentsReceived(), fetchInvoiceSummaries()]);
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
    if (activeTab !== "Invoices") return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchWarehouses();
        if (cancelled) return;
        setWarehouses(rows);
      } catch {
        if (!cancelled) setWarehouses([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "Invoices") return;
    if (!invoiceDraft || invoiceDraft.warehouse_id) return;
    const preferredWarehouse =
      warehouses.find((row) => row.is_active !== false && row.fulfillment_model === "stocked") ||
      warehouses.find((row) => row.is_active !== false) ||
      null;
    if (!preferredWarehouse) return;
    setInvoiceDraft((current) =>
      current && !current.warehouse_id
        ? {
            ...current,
            warehouse_id: preferredWarehouse.id,
            warehouse_code: preferredWarehouse.warehouse_code || "",
            warehouse_name: preferredWarehouse.warehouse_name || "",
          }
        : current,
    );
  }, [activeTab, invoiceDraft, warehouses]);

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
  }, [invoices, selectedInvoiceId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (invoicesView !== "detail" || !selectedInvoiceId) return;
      if (invoiceDraft?.id === selectedInvoiceId && invoiceDraft.lines.length) return;
      try {
        const detail = await fetchInvoiceById(selectedInvoiceId);
        if (!cancelled) {
          setInvoiceDraft(cloneInvoice(detail));
        }
      } catch {
        if (!cancelled) {
          setInvoiceDraft(null);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [invoiceDraft?.id, invoiceDraft?.lines.length, invoicesView, selectedInvoiceId]);

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
    const displayName = customer.company_name || customer.display_name || row.customer_name || "-";
    return [displayName, customer.billing_address || "", customer.company_id ? `Company ID ${customer.company_id}` : "", customer.work_phone ? `Phone: ${customer.work_phone}` : "", customer.email || ""]
      .filter(Boolean)
      .join("\n");
  }

  function buildCustomerShippingBlock(row: LocalInvoice) {
    const customer = findCustomerByNameInList(customers, row.customer_name);
    if (!customer) return row.customer_name || "-";
    const displayName = customer.company_name || customer.display_name || row.customer_name || "-";
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
        oldCode: line.old_code || "",
        description: line.description || "",
        origin: line.origin || "",
        brand: line.brand || "",
        orderNo: row.sales_order_no || "",
        weight: line.weight_kg == null ? "" : String(line.weight_kg),
        gtip: line.hs_code || "",
        alerts: buildInvoicePrintAlerts(line),
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
    try {
      openBusinessDocumentPreview(buildInvoiceHtml(row));
      actionFeedback.succeed(t("sales.invoices.pdfViewOpened"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.invoices.pdfViewFailed"));
    }
  }

  async function handleDeleteInvoice(row: LocalInvoice) {
    if (!window.confirm(t("sales.invoices.deleteConfirm", { invoiceNo: row.id }))) {
      return;
    }
    try {
      actionFeedback.begin(t("sales.invoices.deleting", { invoiceNo: row.id }));
      await deleteInvoice(row.id);
      const refreshed = await fetchInvoiceSummaries();
      setInvoices(refreshed);
      if (selectedInvoiceId === row.id) {
        setSelectedInvoiceId("");
        setInvoiceDraft(null);
        setInvoicesView("list");
        onSelectedInvoiceChange?.("");
      }
      actionFeedback.succeed(t("sales.invoices.deleted", { invoiceNo: row.id }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.invoices.deleteFailed"));
    }
  }

  async function handleDeletePaymentReceived(row: LocalPaymentReceived) {
    if (!window.confirm(t("sales.payments.deleteConfirm", { paymentNo: row.id }))) {
      return;
    }
    try {
      actionFeedback.begin(t("sales.payments.deleting", { paymentNo: row.id }));
      await deletePaymentReceived(row.id);
      const [refreshedPayments, refreshedInvoices] = await Promise.all([fetchPaymentsReceived(), fetchInvoiceSummaries()]);
      setPaymentsReceived(refreshedPayments);
      setInvoices(refreshedInvoices);
      if (selectedPaymentReceivedId === row.id) {
        const next = refreshedPayments[0] || null;
        setSelectedPaymentReceivedId(next?.id || "");
        setPaymentReceivedDraft(next ? { ...next } : createEmptyPaymentReceived(null));
      }
      actionFeedback.succeed(t("sales.payments.deleted", { paymentNo: row.id }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.payments.deleteFailed"));
    }
  }

  const selectedInvoice = useMemo(() => invoices.find((item) => item.id === selectedInvoiceId) || null, [invoices, selectedInvoiceId]);
  const invoiceDiscontinuedLineCount = useMemo(
    () => invoiceDraft?.lines.filter((line) => line.lifecycle_status === "discontinued").length || 0,
    [invoiceDraft],
  );

  function updateInvoiceDraft<K extends keyof LocalInvoice>(key: K, value: LocalInvoice[K]) {
    setInvoiceDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function updateInvoiceWarehouse(warehouseId: string) {
    const selectedWarehouse = warehouses.find((row) => row.id === warehouseId) || null;
    setInvoiceDraft((current) =>
      current
        ? {
            ...current,
            warehouse_id: selectedWarehouse?.id || null,
            warehouse_code: selectedWarehouse?.warehouse_code || "",
            warehouse_name: selectedWarehouse?.warehouse_name || "",
          }
        : current,
    );
  }

  async function handleResyncInvoiceFromCatalog() {
    if (!invoiceDraft) return;
    try {
      setResyncingInvoice(true);
      actionFeedback.begin(t("sales.invoices.resyncingFromCatalog", { invoiceNo: invoiceDraft.id }));
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
      const refreshed = await fetchInvoiceSummaries();
      setInvoices(refreshed);
      setSelectedInvoiceId(saved.id);
      setInvoiceDraft(cloneInvoice(saved));
      actionFeedback.succeed(t("sales.invoices.resyncedFromCatalog"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.invoices.resyncFailed"));
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
      actionFeedback.begin(t("sales.invoices.savingInvoice", { invoiceNo: payload.id }));
      const saved = await upsertInvoice(payload, previousId);
      const next = [saved, ...invoices.filter((item) => item.id !== previousId && item.id !== saved.id)].sort((a, b) =>
        String(b.updated_at).localeCompare(String(a.updated_at)),
      );
      setInvoices(next);
      setSelectedInvoiceId(saved.id);
      setInvoiceDraft(cloneInvoice(saved));
      actionFeedback.succeed(t("sales.invoices.saved", { invoiceNo: saved.id }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.invoices.saveFailed"));
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
      actionFeedback.begin(t("sales.payments.savingPayment", { paymentNo: payload.id }));
      const saved = await upsertPaymentReceived(payload, previousId);
      const [refreshedPayments, refreshedInvoices] = await Promise.all([fetchPaymentsReceived(), fetchInvoiceSummaries()]);
      setPaymentsReceived(refreshedPayments);
      setInvoices(refreshedInvoices);
      setSelectedPaymentReceivedId(saved.id);
      setPaymentReceivedDraft({ ...saved });
      actionFeedback.succeed(t("sales.payments.saved", { paymentNo: saved.id }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.payments.saveFailed"));
    }
  }

  function handleAddPaymentReceived(invoice?: LocalInvoice | null) {
    const next = createEmptyPaymentReceived(invoice || selectedInvoice || null);
    setSelectedPaymentReceivedId(next.id);
    setPaymentReceivedDraft(next);
    setActiveTab("Payments Received");
    actionFeedback.succeed(t("sales.payments.newDraftReady"));
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
      actionFeedback.fail(t("sales.invoices.selectConfirmedFirst"));
      return;
    }
    try {
      actionFeedback.begin(t("sales.invoices.creating", { count: selectedSalesOrderIds.length.toLocaleString("en-US") }));
      const ordersToConvert = await Promise.all(
        salesOrders.filter((order) => selectedSalesOrderIds.includes(order.id)).map((order) => fetchSalesOrderById(order.id)),
      );
      const created = await Promise.all(ordersToConvert.map((order) => upsertInvoice(buildInvoiceFromSalesOrder(order))));
      const refreshed = await fetchInvoiceSummaries();
      setInvoices(refreshed);
      setSelectedSalesOrderIds([]);
      if (created[0]) {
        setSelectedInvoiceId(created[0].id);
        setInvoiceDraft(cloneInvoice(created[0]));
      }
      actionFeedback.succeed(t("sales.invoices.created", { count: created.length.toLocaleString("en-US") }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.invoices.createFailed"));
    }
  }

  async function handleMergeInvoicesFromSelection() {
    if (!selectedSalesOrderIds.length) {
      actionFeedback.fail(t("sales.invoices.selectConfirmedFirst"));
      return;
    }

    const selectedOrders = await Promise.all(
      salesOrders.filter((order) => selectedSalesOrderIds.includes(order.id)).map((order) => fetchSalesOrderById(order.id)),
    );
    if (!selectedOrders.length) {
      actionFeedback.fail(t("sales.invoices.selectedOrdersUnresolved"));
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
      actionFeedback.fail(t("sales.invoices.mergeRequiresSameCustomerCurrencySeller"));
      return;
    }

    try {
      actionFeedback.begin(t("sales.invoices.merging", { count: selectedOrders.length.toLocaleString("en-US") }));
      const merged = await upsertInvoice(buildMergedInvoiceFromSalesOrders(selectedOrders));
      const refreshed = await fetchInvoiceSummaries();
      setInvoices(refreshed);
      setSelectedSalesOrderIds([]);
      setSelectedInvoiceId(merged.id);
      setInvoiceDraft(cloneInvoice(merged));
      actionFeedback.succeed(t("sales.invoices.mergedCreated", { invoiceNo: merged.id, count: selectedOrders.length.toLocaleString("en-US") }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.invoices.mergeFailed"));
    }
  }

  const invoiceColumns = [
    { key: "invoice", header: t("sales.invoices.invoiceNo"), render: (row: LocalInvoice) => row.id, sortValue: (row: LocalInvoice) => row.id },
    { key: "salesOrder", header: t("sales.invoices.salesOrder"), render: (row: LocalInvoice) => row.sales_order_no, sortValue: (row: LocalInvoice) => row.sales_order_no },
    {
      key: "brands",
      header: t("sales.common.brand"),
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
      sortValue: (row: LocalInvoice) => buildInvoiceBrandSummary(row.lines).labels.join(", "),
    },
    {
      key: "customer",
      header: t("sales.common.customer"),
      render: (row: LocalInvoice) => (
        <span title={row.customer_name || "-"}>
          {findCustomerByNameInList(customers, row.customer_name)?.display_name?.trim() || buildEntityAlias(row.customer_name)}
        </span>
      ),
      sortValue: (row: LocalInvoice) => findCustomerByNameInList(customers, row.customer_name)?.display_name?.trim() || buildEntityAlias(row.customer_name),
    },
    {
      key: "seller",
      header: t("sales.invoices.sellerCompany"),
      render: (row: LocalInvoice) => <span title={row.seller_company || "-"}>{buildEntityAlias(row.seller_company)}</span>,
      sortValue: (row: LocalInvoice) => buildEntityAlias(row.seller_company),
    },
    { key: "date", header: t("sales.common.date"), render: (row: LocalInvoice) => row.quote_date || "-", sortValue: (row: LocalInvoice) => row.quote_date || "" },
    { key: "amount", header: t("sales.invoices.totalAmount"), render: (row: LocalInvoice) => `${row.total_amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}`, sortValue: (row: LocalInvoice) => row.total_amount },
    { key: "profit", header: t("sales.invoices.profit"), render: (row: LocalInvoice) => `${row.profit_total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}`, sortValue: (row: LocalInvoice) => row.profit_total },
    { key: "margin", header: t("sales.invoices.marginPercent"), render: (row: LocalInvoice) => `${row.margin_percent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`, sortValue: (row: LocalInvoice) => row.margin_percent },
    { key: "status", header: t("sales.invoices.status"), render: (row: LocalInvoice) => t(`sales.statuses.${row.status}`), sortValue: (row: LocalInvoice) => row.status },
    {
      key: "actions",
      header: t("common.actions"),
      render: (row: LocalInvoice) => (
        <div className="inline-actions">
          <Button
            variant="secondary"
            className="button--compact"
            onClick={(event) => {
              event.stopPropagation();
              handlePrintInvoice(row);
            }}
          >
            PDF / Print
          </Button>
          <Button
            variant="secondary"
            className="button--compact danger-button"
            onClick={(event) => {
              event.stopPropagation();
              void handleDeleteInvoice(row);
            }}
          >
            {t("common.delete")}
          </Button>
        </div>
      ),
    },
  ];

  const paymentReceivedColumns = [
    { key: "payment", header: t("sales.payments.paymentNo"), render: (row: LocalPaymentReceived) => row.id },
    { key: "invoice", header: t("sales.payments.invoice"), render: (row: LocalPaymentReceived) => row.invoice_no || "-" },
    { key: "customer", header: t("sales.common.customer"), render: (row: LocalPaymentReceived) => row.customer_name || "-" },
    { key: "date", header: t("sales.common.date"), render: (row: LocalPaymentReceived) => row.received_date || "-" },
    { key: "method", header: t("sales.payments.method"), render: (row: LocalPaymentReceived) => row.method || "-" },
    { key: "reference", header: t("sales.payments.referenceNo"), render: (row: LocalPaymentReceived) => row.reference_no || "-" },
    { key: "amount", header: t("sales.payments.amount"), render: (row: LocalPaymentReceived) => formatMoney(row.amount, row.currency) },
    { key: "status", header: t("sales.payments.status"), render: (row: LocalPaymentReceived) => t(`sales.statuses.${row.status}`) },
    {
      key: "actions",
      header: t("common.delete"),
      render: (row: LocalPaymentReceived) => (
        <Button
          variant="secondary"
          className="button--compact danger-button"
          onClick={(event) => {
            event.stopPropagation();
            void handleDeletePaymentReceived(row);
          }}
        >
          {t("common.delete")}
        </Button>
      ),
    },
  ];

  return (
    <div className="page-stack">
      {activeTab === "Sales Orders" ? (
        <QuotesPage
          salesOrdersNavTick={salesOrdersNavTick}
          selectedSalesOrderId={selectedSalesOrderId}
          onSelectedSalesOrderChange={onSelectedSalesOrderChange}
          selectedQuoteId={selectedQuoteId}
          onSelectedQuoteChange={onSelectedQuoteChange}
        />
      ) : null}
      {activeTab === "Price Lists" ? <PriceListsPage /> : null}
      {activeTab === "Customers" ? <CustomersPage /> : null}
      {activeTab === "Invoices" ? (
        <SectionCard title={t("nav.invoices")}>
          {invoiceReadyOrders.length ? (
            <div className="invoice-bulk-panel">
              <strong>{t("sales.invoices.convertConfirmedSalesOrders")}</strong>
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
                <Button onClick={handleCreateInvoicesFromSelection}>{t("sales.invoices.createInvoices")}</Button>
                <Button variant="secondary" onClick={handleMergeInvoicesFromSelection}>
                  {t("sales.invoices.mergeIntoOneInvoice")}
                </Button>
                <Button variant="secondary" onClick={() => handleAddPaymentReceived()}>
                  {t("sales.invoices.addPaymentReceived")}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="meta-row">
            <span>{t("sales.invoices.invoicesLoaded", { count: invoices.length.toLocaleString("en-US") })}</span>
            <span>{t("sales.invoices.createdFromConfirmedSalesOrders")}</span>
          </div>
          {invoicesView === "list" ? (
            <DataTable
              rows={invoices}
              columns={invoiceColumns}
              emptyText={t("sales.invoices.noInvoicesYet")}
              onRowClick={(row) => {
                setSelectedInvoiceId(row.id);
                setInvoiceDraft(null);
                setInvoicesView("detail");
                onSelectedInvoiceChange?.(row.id);
              }}
              rowClassName={(row) => (row.id === selectedInvoiceId ? "data-table__row--active" : "")}
            />
          ) : null}
          {invoicesView === "detail" && selectedInvoice && invoiceDraft ? (
            <div className="invoice-editor-block">
              <div className="invoice-edit-shell">
                <div className="toolbar toolbar--wrap">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setInvoicesView("list");
                      onSelectedInvoiceChange?.("");
                    }}
                  >
                    {t("common.back")}
                  </Button>
                </div>
                <div className="invoice-meta-grid">
                  <Input label={t("sales.invoices.invoiceNo")} value={invoiceDraft.id} onChange={(value) => updateInvoiceDraft("id", value)} />
                  <Input label={t("sales.invoices.salesOrder")} value={invoiceDraft.sales_order_no} onChange={(value) => updateInvoiceDraft("sales_order_no", value)} />
                  <Select
                    label={t("sales.invoices.warehouse")}
                    value={invoiceDraft.warehouse_id || ""}
                    options={[
                      { value: "", label: t("sales.invoices.selectWarehouse") },
                      ...warehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}`.trim() })),
                    ]}
                    onChange={updateInvoiceWarehouse}
                  />
                  <Input label={t("sales.common.customer")} value={invoiceDraft.customer_name} onChange={(value) => updateInvoiceDraft("customer_name", value)} />
                  <Input label={t("sales.invoices.invoiceDate")} type="date" value={invoiceDraft.quote_date} onChange={(value) => updateInvoiceDraft("quote_date", value)} />
                  <Input label={t("sales.invoices.dueDate")} type="date" value={invoiceDraft.due_date} onChange={(value) => updateInvoiceDraft("due_date", value)} />
                  <Select
                    label={t("sales.invoices.status")}
                    value={invoiceDraft.status}
                    options={[
                      { value: "draft", label: t("sales.invoices.statusDraft") },
                      { value: "confirmed", label: t("sales.invoices.statusConfirmed") },
                      { value: "paid", label: t("sales.invoices.statusPaid") },
                      { value: "void", label: t("sales.invoices.statusVoid") },
                    ]}
                    onChange={(value) => updateInvoiceDraft("status", value as LocalInvoice["status"])}
                  />
                  <Select
                    label={t("sales.invoices.terms")}
                    value={invoiceDraft.payment_terms}
                    options={[
                      { value: "Cash in Advance", label: t("sales.invoices.termCashInAdvance") },
                      { value: "Due on Receipt", label: t("sales.invoices.termDueOnReceipt") },
                      { value: "Net 7", label: t("sales.invoices.termNet7") },
                      { value: "Net 15", label: t("sales.invoices.termNet15") },
                      { value: "Net 30", label: t("sales.invoices.termNet30") },
                      { value: "Net 45", label: t("sales.invoices.termNet45") },
                      { value: "Net 60", label: t("sales.invoices.termNet60") },
                    ]}
                    onChange={(value) => updateInvoiceDraft("payment_terms", value)}
                  />
                  <Input label={t("sales.invoices.contractNr")} value={invoiceDraft.contract_nr} onChange={(value) => updateInvoiceDraft("contract_nr", value)} />
                  <Input label={t("sales.invoices.packingDetails")} value={invoiceDraft.packing_details} onChange={(value) => updateInvoiceDraft("packing_details", value)} />
                  <Input label={t("sales.invoices.discount")} type="number" value={String(invoiceDraft.discount_amount)} onChange={(value) => setInvoiceDraft((current) => (current ? recomputeInvoiceTotals({ ...current, discount_amount: Number(value || 0) }) : current))} />
                  <Input label={t("sales.invoices.shippingHandling")} type="number" value={String(invoiceDraft.shipping_cost)} onChange={(value) => setInvoiceDraft((current) => (current ? recomputeInvoiceTotals({ ...current, shipping_cost: Number(value || 0) }) : current))} />
                  <Input label={t("sales.invoices.subTotal")} type="number" value={String(invoiceDraft.subtotal)} onChange={() => undefined} disabled />
                  <Input label={t("sales.invoices.currency")} value={invoiceDraft.currency} onChange={(value) => updateInvoiceDraft("currency", value)} />
                </div>
                <table className="simple-edit-table">
                  <thead>
                    <tr>
                      <th>{t("sales.invoices.table.code")}</th>
                      <th>{t("sales.invoices.table.description")}</th>
                      <th>{t("sales.invoices.table.qty")}</th>
                      <th>{t("sales.invoices.table.buy")}</th>
                      <th>{t("sales.invoices.table.sell")}</th>
                      <th>{t("sales.invoices.table.lineTotal")}</th>
                      <th>{t("sales.invoices.table.notes")}</th>
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
                    {t("sales.invoices.discontinuedDetected", { count: invoiceDiscontinuedLineCount.toLocaleString("en-US") })}
                  </div>
                ) : null}
                <div className="quote-summary-card">
                  <div className="quote-summary-row">
                    <span>{t("sales.invoices.summary.subTotal")}</span>
                    <strong>{formatMoney(invoiceDraft.subtotal, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-row">
                    <span>{t("sales.invoices.summary.discount")}</span>
                    <strong>{formatMoney(invoiceDraft.discount_amount, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-row">
                    <span>{t("sales.invoices.summary.shippingHandling")}</span>
                    <strong>{formatMoney(invoiceDraft.shipping_cost, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-row quote-summary-row--total">
                    <span>{t("sales.invoices.summary.totalAmount")}</span>
                    <strong>{formatMoney(invoiceDraft.total_amount, invoiceDraft.currency)}</strong>
                  </div>
                  <div className="quote-summary-internal">
                    <div className="quote-summary-mini">
                      <span>{t("sales.invoices.summary.purchaseTotal")}</span>
                      <strong>{formatMoney(invoiceDraft.purchase_total, invoiceDraft.currency)}</strong>
                    </div>
                    <div className="quote-summary-mini">
                      <span>{t("sales.invoices.summary.profit")}</span>
                      <strong>{formatMoney(invoiceDraft.profit_total, invoiceDraft.currency)}</strong>
                    </div>
                    <div className="quote-summary-mini">
                      <span>{t("sales.invoices.summary.marginPercent")}</span>
                      <strong>{invoiceDraft.margin_percent.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</strong>
                    </div>
                  </div>
                </div>
                <div className="field field--full">
                  <label className="field__label">{t("sales.invoices.notes")}</label>
                  <textarea className="field__input field__input--textarea" value={invoiceDraft.notes} onChange={(event) => updateInvoiceDraft("notes", event.target.value)} />
                </div>
                <div className="toolbar toolbar--wrap">
                  <label className="checkbox-field quote-toolbar-checkbox">
                    <input type="checkbox" checked={invoiceResyncOnlyFillBlanks} onChange={(event) => setInvoiceResyncOnlyFillBlanks(event.target.checked)} />
                    <span className="field__label">{t("sales.invoices.onlyFillBlanks")}</span>
                  </label>
                  <label className="checkbox-field quote-toolbar-checkbox">
                    <input type="checkbox" checked={invoiceResyncKeepPrices} onChange={(event) => setInvoiceResyncKeepPrices(event.target.checked)} />
                    <span className="field__label">{t("sales.invoices.keepPrices")}</span>
                  </label>
                  <Button variant="secondary" onClick={() => void handleResyncInvoiceFromCatalog()} busy={resyncingInvoice} busyLabel={t("sales.invoices.resyncing")}>
                    {t("sales.invoices.resyncFromCatalog")}
                  </Button>
                  <Button onClick={saveInvoiceDraft}>{t("sales.invoices.saveInvoice")}</Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setInvoiceDraft((current) => (current ? { ...current, status: "confirmed" } : current));
                    }}
                  >
                    {t("sales.invoices.markConfirmed")}
                  </Button>
                  <Button variant="secondary" onClick={() => handlePrintInvoice(invoiceDraft)}>
                    PDF / Print
                  </Button>
                  <Button variant="secondary" onClick={() => handleAddPaymentReceived(invoiceDraft)}>
                    {t("sales.invoices.addPayment")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
      {activeTab === "Payments Received" ? (
        <SectionCard title={t("nav.paymentsReceived")}>
          <div className="meta-row">
            <span>{t("sales.payments.paymentsLoaded", { count: paymentsReceived.length.toLocaleString("en-US") })}</span>
            <span>{t("sales.payments.description")}</span>
          </div>
          <div className="toolbar toolbar--wrap">
            <Button onClick={() => handleAddPaymentReceived()}>+ {t("sales.invoices.addPaymentReceived")}</Button>
          </div>
          <DataTable
            rows={paymentsReceived}
            columns={paymentReceivedColumns}
            emptyText={t("sales.payments.noReceivedPaymentsYet")}
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
                  <Input label={t("sales.payments.paymentNo")} value={paymentReceivedDraft.id} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, id: value } : current))} />
                  <label className="field">
                    <span className="field__label">{t("sales.payments.invoice")}</span>
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
                      <option value="">{t("sales.payments.manualUnlinked")}</option>
                      {invoices.map((invoice) => (
                        <option key={invoice.id} value={invoice.id}>
                          {invoice.id} - {invoice.customer_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Input label={t("sales.payments.invoiceNo")} value={paymentReceivedDraft.invoice_no} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, invoice_no: value } : current))} />
                  <Input label={t("sales.payments.customer")} value={paymentReceivedDraft.customer_name} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, customer_name: value } : current))} />
                  <Input label={t("sales.payments.receivedDate")} type="date" value={paymentReceivedDraft.received_date} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, received_date: value } : current))} />
                  <Input label={t("sales.payments.amount")} type="number" value={String(paymentReceivedDraft.amount)} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, amount: Number(value || 0) } : current))} />
                  <Select
                    label={t("sales.payments.method")}
                    value={paymentReceivedDraft.method}
                    options={[
                      { value: "Bank Transfer", label: t("sales.payments.bankTransfer") },
                      { value: "Cash", label: t("sales.payments.cash") },
                      { value: "Credit Card", label: t("sales.payments.creditCard") },
                      { value: "Cheque", label: t("sales.payments.cheque") },
                    ]}
                    onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, method: value } : current))}
                  />
                  <Input label={t("sales.payments.referenceNo")} value={paymentReceivedDraft.reference_no} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, reference_no: value } : current))} />
                  <Select
                    label={t("sales.payments.status")}
                    value={paymentReceivedDraft.status}
                    options={[
                      { value: "draft", label: t("sales.payments.statusDraft") },
                      { value: "confirmed", label: t("sales.payments.statusConfirmed") },
                      { value: "void", label: t("sales.payments.statusVoid") },
                    ]}
                    onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, status: value as LocalPaymentReceived["status"] } : current))}
                  />
                  <Input label={t("sales.payments.currency")} value={paymentReceivedDraft.currency} onChange={(value) => setPaymentReceivedDraft((current) => (current ? { ...current, currency: value } : current))} />
                </div>
                <div className="field field--full">
                  <label className="field__label">{t("sales.payments.notes")}</label>
                  <textarea className="field__input field__input--textarea" value={paymentReceivedDraft.notes} onChange={(event) => setPaymentReceivedDraft((current) => (current ? { ...current, notes: event.target.value } : current))} />
                </div>
                <div className="toolbar toolbar--wrap">
                  <Button onClick={savePaymentReceivedDraft}>{t("sales.payments.savePayment")}</Button>
                  <Button variant="secondary" onClick={() => setPaymentReceivedDraft((current) => (current ? { ...current, status: "confirmed" } : current))}>
                    {t("sales.payments.markConfirmed")}
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
