import { useEffect, useMemo, useState } from "react";
import { deliverQueuedEmails, queueVendorPurchaseOrderEmail } from "../../infrastructure/api/emailTemplatesApi";
import { buildInventoryAvailabilityLookup, fetchInventoryAvailabilitySummary, inventoryAvailabilityLookupKey, type InventoryAvailabilitySummary } from "../../infrastructure/api/inventoryApi";
import {
  buildAndUpsertBillFromPurchaseOrder,
  deletePurchaseOrder,
  fetchBills,
  fetchPaymentsMade,
  fetchPurchaseOrders,
  upsertBill,
  upsertPaymentMade,
  upsertPurchaseOrder,
} from "../../infrastructure/api/ordersApi";
import { VendorsPage } from "./VendorsPage";
import { SectionCard } from "../components/common/SectionCard";
import { fetchCompanyProfiles, findCompanyProfileByName } from "../../infrastructure/api/companyProfilesApi";
import { fetchVendors } from "../../infrastructure/api/vendorsApi";
import { buildBusinessDocumentHtml } from "../../shared/documentPrint";
import { normalizePartCode } from "../../domain/shared/normalize";
import type { CompanyProfile } from "../../types/company";
import type { LocalBill, LocalPaymentMade, LocalPurchaseOrder } from "../../types/orders";
import type { LocalVendor } from "../../types/vendors";
import { DataTable } from "../components/common/DataTable";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";

function formatMoney(value: number, currency = "EUR") {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatAvailabilityQty(value: number) {
  return Number.isInteger(value) ? String(value) : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function sanitizeFileName(value: string) {
  return String(value || "document")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function findInventoryAvailability(
  lookup: Map<string, InventoryAvailabilitySummary>,
  brand: string,
  ...codes: Array<string | null | undefined>
) {
  for (const code of codes) {
    const normalized = normalizePartCode(code || "");
    if (!normalized) continue;
    const match = lookup.get(inventoryAvailabilityLookupKey(brand, normalized));
    if (match) return match;
  }
  return null;
}

function renderInventoryAvailabilityBadge(
  lookup: Map<string, InventoryAvailabilitySummary>,
  input: {
    brand: string;
    qty: number;
    productCode?: string | null;
    oldCode?: string | null;
  },
) {
  const availability = findInventoryAvailability(lookup, input.brand, input.productCode, input.oldCode);
  if (!availability || availability.available_qty <= 0) {
    return <span className="mark-badge mark-badge--danger">No Stock</span>;
  }
  if (availability.available_qty >= input.qty) {
    return (
      <span
        className="mark-badge mark-badge--success"
        title={`${formatAvailabilityQty(availability.available_qty)} available across ${availability.warehouse_count} warehouse(s)`}
      >
        Avail {formatAvailabilityQty(availability.available_qty)}
      </span>
    );
  }
  return (
    <span
      className="mark-badge mark-badge--accent"
      title={`${formatAvailabilityQty(availability.available_qty)} available across ${availability.warehouse_count} warehouse(s)`}
    >
      Short {formatAvailabilityQty(Math.max(0, input.qty - availability.available_qty))}
    </span>
  );
}

type PurchasesPageProps = {
  selectedPurchaseOrderId?: string;
  selectedBillId?: string;
};

export function PurchasesPage({
  selectedPurchaseOrderId: externalSelectedPurchaseOrderId = "",
  selectedBillId: externalSelectedBillId = "",
}: PurchasesPageProps) {
  const actionFeedback = useActionFeedback();
  const [activeTab, setActiveTab] = useState<"Vendors" | "Purchase Orders" | "Bills" | "Payments Made">("Vendors");
  const [purchaseOrders, setPurchaseOrders] = useState<LocalPurchaseOrder[]>([]);
  const [bills, setBills] = useState<LocalBill[]>([]);
  const [selectedPurchaseOrderId, setSelectedPurchaseOrderId] = useState("");
  const [purchaseOrderDraft, setPurchaseOrderDraft] = useState<LocalPurchaseOrder | null>(null);
  const [selectedBillId, setSelectedBillId] = useState("");
  const [billDraft, setBillDraft] = useState<LocalBill | null>(null);
  const [paymentsMade, setPaymentsMade] = useState<LocalPaymentMade[]>([]);
  const [selectedPaymentMadeId, setSelectedPaymentMadeId] = useState("");
  const [paymentMadeDraft, setPaymentMadeDraft] = useState<LocalPaymentMade | null>(null);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [vendors, setVendors] = useState<LocalVendor[]>([]);
  const [printingPurchaseOrder, setPrintingPurchaseOrder] = useState(false);
  const [printingBill, setPrintingBill] = useState(false);
  const [inventoryAvailabilityRows, setInventoryAvailabilityRows] = useState<InventoryAvailabilitySummary[]>([]);
  const inventoryAvailabilityLookup = useMemo(() => buildInventoryAvailabilityLookup(inventoryAvailabilityRows), [inventoryAvailabilityRows]);

  useEffect(() => {
    if (!externalSelectedPurchaseOrderId) return;
    setActiveTab("Purchase Orders");
    setSelectedPurchaseOrderId(externalSelectedPurchaseOrderId);
  }, [externalSelectedPurchaseOrderId]);

  useEffect(() => {
    if (!externalSelectedBillId) return;
    setActiveTab("Bills");
    setSelectedBillId(externalSelectedBillId);
  }, [externalSelectedBillId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        if (activeTab === "Purchase Orders") {
          const purchaseOrderRows = await fetchPurchaseOrders();
          if (cancelled) return;
          setPurchaseOrders(purchaseOrderRows);
          return;
        }

        if (activeTab === "Bills") {
          const billRows = await fetchBills();
          if (cancelled) return;
          setBills(billRows);
          return;
        }

        if (activeTab === "Payments Made") {
          const [paymentRows, billRows] = await Promise.all([fetchPaymentsMade(), fetchBills()]);
          if (cancelled) return;
          setPaymentsMade(paymentRows);
          setBills(billRows);
        }
      } catch {
        if (!cancelled) {
          if (activeTab === "Purchase Orders") setPurchaseOrders([]);
          if (activeTab === "Bills") setBills([]);
          if (activeTab === "Payments Made") {
            setPaymentsMade([]);
            setBills([]);
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
    if (activeTab !== "Purchase Orders" && activeTab !== "Bills") return;
    let cancelled = false;

    async function run() {
      try {
        const rows = await fetchInventoryAvailabilitySummary();
        if (!cancelled) setInventoryAvailabilityRows(rows);
      } catch {
        if (!cancelled) setInventoryAvailabilityRows([]);
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
      const needsReferenceData = activeTab === "Purchase Orders" || activeTab === "Bills";
      if (!needsReferenceData) return;
      try {
        const [profileRows, vendorRows] = await Promise.all([fetchCompanyProfiles(), fetchVendors()]);
        if (cancelled) return;
        setCompanyProfiles(profileRows);
        setVendors(vendorRows);
      } catch {
        if (!cancelled) {
          setCompanyProfiles([]);
          setVendors([]);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  useEffect(() => {
    if (!purchaseOrders.length) {
      setSelectedPurchaseOrderId("");
      setPurchaseOrderDraft(null);
      return;
    }
    const current = purchaseOrders.find((item) => item.id === selectedPurchaseOrderId) || purchaseOrders[0];
    setSelectedPurchaseOrderId(current.id);
    setPurchaseOrderDraft({ ...current, lines: current.lines.map((line) => ({ ...line })) });
  }, [purchaseOrders, selectedPurchaseOrderId]);

  useEffect(() => {
    if (!bills.length) {
      setSelectedBillId("");
      setBillDraft(null);
      return;
    }
    const current = bills.find((item) => item.id === selectedBillId) || bills[0];
    setSelectedBillId(current.id);
    setBillDraft({ ...current, lines: current.lines.map((line) => ({ ...line })) });
  }, [bills, selectedBillId]);

  useEffect(() => {
    if (!paymentsMade.length) {
      const next = createEmptyPaymentMade();
      setSelectedPaymentMadeId(next.id);
      setPaymentMadeDraft(next);
      return;
    }
    const current = paymentsMade.find((item) => item.id === selectedPaymentMadeId) || paymentsMade[0];
    setSelectedPaymentMadeId(current.id);
    setPaymentMadeDraft({ ...current });
  }, [paymentsMade, selectedPaymentMadeId]);

  const purchaseOrderColumns = useMemo(
    () => [
      { key: "po", header: "PO No", render: (row: LocalPurchaseOrder) => row.id },
      { key: "supplier", header: "Vendor", render: (row: LocalPurchaseOrder) => row.supplier_name },
      { key: "company", header: "Purchase Company", render: (row: LocalPurchaseOrder) => row.purchase_company || "-" },
      { key: "sales", header: "Sales Order", render: (row: LocalPurchaseOrder) => row.sales_order_no },
      { key: "customer", header: "Customer", render: (row: LocalPurchaseOrder) => row.customer_name || "-" },
      { key: "lines", header: "Lines", render: (row: LocalPurchaseOrder) => row.line_count },
      { key: "amount", header: "Purchase Total", render: (row: LocalPurchaseOrder) => formatMoney(row.total_amount, row.currency) },
      { key: "status", header: "Status", render: (row: LocalPurchaseOrder) => row.status },
      { key: "created", header: "Created", render: (row: LocalPurchaseOrder) => row.created_at.slice(0, 10) },
    ],
    [],
  );

  const billColumns = useMemo(
    () => [
      { key: "bill", header: "Bill No", render: (row: LocalBill) => row.id },
      { key: "po", header: "Purchase Order", render: (row: LocalBill) => row.purchase_order_no },
      { key: "supplier", header: "Vendor", render: (row: LocalBill) => row.supplier_name },
      { key: "company", header: "Purchase Company", render: (row: LocalBill) => row.purchase_company || "-" },
      { key: "date", header: "Bill Date", render: (row: LocalBill) => row.bill_date || "-" },
      { key: "due", header: "Due Date", render: (row: LocalBill) => row.due_date || "-" },
      { key: "amount", header: "Total Amount", render: (row: LocalBill) => formatMoney(row.total_amount, row.currency) },
      { key: "status", header: "Status", render: (row: LocalBill) => row.status },
    ],
    [],
  );

  const paymentMadeColumns = useMemo(
    () => [
      { key: "payment", header: "Payment No", render: (row: LocalPaymentMade) => row.id },
      { key: "bill", header: "Bill", render: (row: LocalPaymentMade) => row.bill_no || "-" },
      { key: "vendor", header: "Vendor", render: (row: LocalPaymentMade) => row.supplier_name || "-" },
      { key: "date", header: "Date", render: (row: LocalPaymentMade) => row.payment_date || "-" },
      { key: "method", header: "Method", render: (row: LocalPaymentMade) => row.method || "-" },
      { key: "reference", header: "Reference", render: (row: LocalPaymentMade) => row.reference_no || "-" },
      { key: "amount", header: "Amount", render: (row: LocalPaymentMade) => formatMoney(row.amount, row.currency) },
      { key: "status", header: "Status", render: (row: LocalPaymentMade) => row.status },
    ],
    [],
  );

  const billCountByPurchaseOrderId = useMemo(() => {
    const map = new Map<string, number>();
    bills.forEach((bill) => {
      if (!bill.purchase_order_id) return;
      map.set(bill.purchase_order_id, (map.get(bill.purchase_order_id) || 0) + 1);
    });
    return map;
  }, [bills]);

  const purchaseOrderColumnsWithMarks = useMemo(
    () =>
      purchaseOrderColumns.map((column) =>
        column.key !== "status"
          ? column
          : {
              ...column,
              render: (row: LocalPurchaseOrder) => (
                <div className="document-marks">
                  <span className={`mark-badge ${row.status === "confirmed" || row.status === "closed" ? "mark-badge--success" : ""}`}>
                    {row.status.toUpperCase()}
                  </span>
                  {(billCountByPurchaseOrderId.get(row.id) || 0) > 0 ? (
                    <span className="mark-badge mark-badge--accent">Bill {billCountByPurchaseOrderId.get(row.id)}</span>
                  ) : null}
                </div>
              ),
            },
      ),
    [purchaseOrderColumns, billCountByPurchaseOrderId],
  );

  function findVendorByName(name: string) {
    const key = name.trim().toLowerCase();
    return vendors.find((item) => item.display_name.trim().toLowerCase() === key || item.company_name.trim().toLowerCase() === key) || null;
  }

  function buildVendorAddressBlock(vendorName: string) {
    const vendor = findVendorByName(vendorName);
    if (!vendor) return vendorName || "-";
    const displayName = vendor.display_name || vendor.company_name || vendorName || "-";
    return [displayName, vendor.billing_address || "", vendor.company_id ? `Company ID ${vendor.company_id}` : "", vendor.work_phone ? `Phone: ${vendor.work_phone}` : "", vendor.email || ""]
      .filter(Boolean)
      .join("\n");
  }

  function buildPurchaseOrderHtml(row: LocalPurchaseOrder) {
    const company =
      findCompanyProfileByName(companyProfiles, row.purchase_company) || {
        id: "",
        companyName: row.purchase_company || "Company",
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
    return buildBusinessDocumentHtml({
      docType: "Purchase Order",
      docNo: row.id,
      company: {
        companyName: company.companyName || "",
        address: company.address || "",
        bankDetails: company.bankDetails || "",
        taxNumber: company.taxNumber || "",
        logoDataUrl: company.logoDataUrl || "",
      },
      party: {
        title: "Vendor",
        details: buildVendorAddressBlock(row.supplier_name),
      },
      meta: [
        { label: "PO Date", value: row.created_at?.slice(0, 10) || "-" },
        { label: "Status", value: row.status || "-" },
        { label: "Sales Order", value: row.sales_order_no || "-" },
        { label: "Customer", value: row.customer_name || "-" },
        { label: "Currency", value: row.currency || "EUR" },
      ],
      lines: row.lines.map((line) => ({
        code: line.product_code,
        description: line.description || "",
        origin: line.origin || "",
        brand: line.brand || "",
        orderNo: row.id,
        weight: "",
        gtip: "",
        qty: line.qty,
        unitPrice: Number(line.buy_price || 0) || 0,
        amount: Number(line.line_total || 0) || 0,
      })),
      totals: {
        currency: row.currency || "EUR",
        subtotal: Number(row.total_amount || 0) || 0,
        total: Number(row.total_amount || 0) || 0,
      },
      totalQty: row.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
    });
  }

  function buildBillHtml(row: LocalBill) {
    const company =
      findCompanyProfileByName(companyProfiles, row.purchase_company) || {
        id: "",
        companyName: row.purchase_company || "Company",
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
    return buildBusinessDocumentHtml({
      docType: "Bill",
      docNo: row.id,
      company: {
        companyName: company.companyName || "",
        address: company.address || "",
        bankDetails: company.bankDetails || "",
        taxNumber: company.taxNumber || "",
        logoDataUrl: company.logoDataUrl || "",
      },
      party: {
        title: "Vendor",
        details: buildVendorAddressBlock(row.supplier_name),
      },
      meta: [
        { label: "Bill Date", value: row.bill_date || "-" },
        { label: "Due Date", value: row.due_date || "-" },
        { label: "Terms", value: row.payment_terms || "-" },
        { label: "Purchase Order", value: row.purchase_order_no || "-" },
        { label: "Status", value: row.status || "-" },
      ],
      lines: row.lines.map((line) => ({
        code: line.product_code,
        description: line.description || "",
        origin: line.origin || "",
        brand: line.brand || "",
        orderNo: row.purchase_order_no || row.id,
        weight: "",
        gtip: "",
        qty: line.qty,
        unitPrice: Number(line.buy_price || 0) || 0,
        amount: Number(line.line_total || 0) || 0,
      })),
      totals: {
        currency: row.currency || "EUR",
        subtotal: Number(row.subtotal || 0) || 0,
        discount: Number(row.discount_amount || 0) || 0,
        shipping: Number(row.shipping_cost || 0) || 0,
        total: Number(row.total_amount || 0) || 0,
      },
      notes: row.notes || "",
      totalQty: row.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
    });
  }

  function handlePrintPurchaseOrder(row: LocalPurchaseOrder) {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      actionFeedback.fail("Popup blocked while opening PDF view.");
      return;
    }
    setPrintingPurchaseOrder(true);
    try {
      actionFeedback.begin(`Preparing purchase order ${row.id}...`);
      win.document.write(buildPurchaseOrderHtml(row));
      win.document.close();
      win.focus();
      actionFeedback.succeed("Purchase order PDF view opened.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Purchase order print failed");
    } finally {
      setPrintingPurchaseOrder(false);
    }
  }

  function handleExportPurchaseOrderExcel(row: LocalPurchaseOrder) {
    try {
      const rows: Array<Array<string | number | null | undefined>> = [
        ["Purchase Order", row.id],
        ["Vendor", row.supplier_name],
        ["Purchase Company", row.purchase_company || ""],
        ["Status", row.status || ""],
        ["Currency", row.currency || "EUR"],
        ["Created", row.created_at?.slice(0, 10) || ""],
        [],
        ["Code", "Brand", "Description", "Qty", "OEM", "Origin", `Buy Price ${row.currency || "EUR"}`, `Line Total ${row.currency || "EUR"}`, "Notes"],
        ...row.lines.map((line) => [
          line.product_code || line.old_code || "",
          line.brand || "",
          line.description || "",
          Number(line.qty || 0),
          line.oem_no || "",
          line.origin || "",
          Number(line.buy_price || 0),
          Number(line.line_total || 0),
          line.notes || "",
        ]),
        [],
        ["Total Amount", "", "", "", "", "", "", Number(row.total_amount || 0)],
      ];
      const blob = buildXlsxBlob((row.id || "purchase-order").slice(0, 31), rows, [3, 6, 7]);
      downloadBlob(`${sanitizeFileName(row.id || "purchase-order")}.xlsx`, blob);
      actionFeedback.succeed(`Excel exported for ${row.id}.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Purchase order Excel export failed");
    }
  }

  function handlePrintBill(row: LocalBill) {
    const win = window.open("about:blank", "_blank");
    if (!win) {
      actionFeedback.fail("Popup blocked while opening PDF view.");
      return;
    }
    setPrintingBill(true);
    try {
      actionFeedback.begin(`Preparing bill ${row.id}...`);
      win.document.write(buildBillHtml(row));
      win.document.close();
      win.focus();
      actionFeedback.succeed("Bill PDF view opened.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Bill print failed");
    } finally {
      setPrintingBill(false);
    }
  }

  function recomputePurchaseOrderTotals(draft: LocalPurchaseOrder): LocalPurchaseOrder {
    const lines = draft.lines.map((line) => ({
      ...line,
      buy_price: Number(line.buy_price || 0),
      qty: Math.max(1, Number(line.qty || 1) || 1),
      line_total: Math.round((Math.max(1, Number(line.qty || 1) || 1) * Number(line.buy_price || 0)) * 100) / 100,
    }));
    const total_amount = Math.round(lines.reduce((sum, line) => sum + line.line_total, 0) * 100) / 100;
    return {
      ...draft,
      line_count: lines.length,
      total_amount,
      updated_at: new Date().toISOString(),
      lines,
    };
  }

  function recomputeBillTotals(draft: LocalBill): LocalBill {
    const lines = draft.lines.map((line) => ({
      ...line,
      buy_price: Number(line.buy_price || 0),
      qty: Math.max(1, Number(line.qty || 1) || 1),
      line_total: Math.round((Math.max(1, Number(line.qty || 1) || 1) * Number(line.buy_price || 0)) * 100) / 100,
    }));
    const subtotal = Math.round(lines.reduce((sum, line) => sum + line.line_total, 0) * 100) / 100;
    const total_amount = Math.round((subtotal - Number(draft.discount_amount || 0) + Number(draft.shipping_cost || 0)) * 100) / 100;
    return {
      ...draft,
      subtotal,
      total_amount,
      updated_at: new Date().toISOString(),
      lines,
    };
  }

  function createEmptyPaymentMade(bill?: LocalBill | null): LocalPaymentMade {
    const now = new Date().toISOString();
    return {
      id: `PM-${Date.now()}`,
      bill_id: bill?.id || "",
      bill_no: bill?.id || "",
      supplier_name: bill?.supplier_name || "",
      purchase_company: bill?.purchase_company || "",
      currency: bill?.currency || "EUR",
      payment_date: now.slice(0, 10),
      amount: Number(bill?.total_amount || 0) || 0,
      method: "Bank Transfer",
      reference_no: "",
      notes: "",
      status: "draft",
      created_at: now,
      updated_at: now,
    };
  }

  async function savePurchaseOrderDraft() {
    if (!purchaseOrderDraft) return;
    const previousStatus = purchaseOrders.find((item) => item.id === purchaseOrderDraft.id)?.status || "";
    try {
      actionFeedback.begin(`Saving purchase order ${purchaseOrderDraft.id}...`);
      const saved = await upsertPurchaseOrder(recomputePurchaseOrderTotals(purchaseOrderDraft));
      let message = `Purchase order ${saved.id} saved.`;
      if (saved.status === "confirmed" && previousStatus !== "confirmed") {
        try {
          const queued = await queueVendorPurchaseOrderEmail(saved, saved.purchase_company || "Next Master", window.location.origin);
          const delivery = await deliverQueuedEmails([queued.id]);
          message =
            delivery.sentCount > 0
              ? `${message} Vendor email sent to ${saved.supplier_name}.`
              : `${message} Vendor email queued for ${saved.supplier_name}, but delivery did not complete on this runtime.`;
        } catch (caught) {
          message = `${message} ${caught instanceof Error ? caught.message : "Vendor email queue failed."}`;
        }
      }
      const refreshed = await fetchPurchaseOrders();
      setPurchaseOrders(refreshed);
      setSelectedPurchaseOrderId(saved.id);
      setPurchaseOrderDraft({ ...saved, lines: saved.lines.map((line) => ({ ...line })) });
      actionFeedback.succeed(message);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Purchase order save failed");
    }
  }

  async function handleDeletePurchaseOrder() {
    if (!purchaseOrderDraft) return;
    const poId = purchaseOrderDraft.id;
    const relatedBillCount = billCountByPurchaseOrderId.get(poId) || 0;

    if (relatedBillCount > 0) {
      actionFeedback.fail(`Purchase order ${poId} cannot be deleted because ${relatedBillCount.toLocaleString("en-US")} bill record exists.`);
      return;
    }

    if (!window.confirm(`Delete purchase order ${poId}? This cannot be undone.`)) {
      return;
    }

    try {
      actionFeedback.begin(`Deleting purchase order ${poId}...`);
      await deletePurchaseOrder(poId);
      const refreshed = await fetchPurchaseOrders();
      setPurchaseOrders(refreshed);
      actionFeedback.succeed(`Purchase order ${poId} deleted.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Purchase order delete failed");
    }
  }

  async function convertPurchaseOrderToBill() {
    if (!purchaseOrderDraft) return;
    try {
      actionFeedback.begin(`Converting ${purchaseOrderDraft.id} to bill...`);
      const saved = await buildAndUpsertBillFromPurchaseOrder(recomputePurchaseOrderTotals(purchaseOrderDraft));
      const refreshed = await fetchBills();
      setBills(refreshed);
      setSelectedBillId(saved.id);
      setBillDraft({ ...saved, lines: saved.lines.map((line) => ({ ...line })) });
      setActiveTab("Bills");
      actionFeedback.succeed(`Bill ${saved.id} created from ${purchaseOrderDraft.id}.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Convert to bill failed");
    }
  }

  async function saveBillDraft() {
    if (!billDraft) return;
    try {
      actionFeedback.begin(`Saving bill ${billDraft.id}...`);
      const saved = await upsertBill(recomputeBillTotals(billDraft), selectedBillId);
      const refreshed = await fetchBills();
      setBills(refreshed);
      setSelectedBillId(saved.id);
      setBillDraft({ ...saved, lines: saved.lines.map((line) => ({ ...line })) });
      actionFeedback.succeed(`Bill ${saved.id} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Bill save failed");
    }
  }

  async function savePaymentMadeDraft() {
    if (!paymentMadeDraft) return;
    const previousId = selectedPaymentMadeId;
    const payload: LocalPaymentMade = {
      ...paymentMadeDraft,
      amount: Number(paymentMadeDraft.amount || 0),
      updated_at: new Date().toISOString(),
    };
    try {
      actionFeedback.begin(`Saving payment ${payload.id}...`);
      const saved = await upsertPaymentMade(payload, previousId);
      const [refreshedPayments, refreshedBills] = await Promise.all([fetchPaymentsMade(), fetchBills()]);
      setPaymentsMade(refreshedPayments);
      setBills(refreshedBills);
      setSelectedPaymentMadeId(saved.id);
      setPaymentMadeDraft({ ...saved });
      actionFeedback.succeed(`Payment ${saved.id} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Payment save failed");
    }
  }

  function handleAddPaymentMade(bill?: LocalBill | null) {
    const next = createEmptyPaymentMade(bill || billDraft || null);
    setSelectedPaymentMadeId(next.id);
    setPaymentMadeDraft(next);
    setActiveTab("Payments Made");
    actionFeedback.succeed("New payment draft ready.");
  }

  return (
    <div className="page-stack">
      <div className="module-tabs">
        {(["Vendors", "Purchase Orders", "Bills", "Payments Made"] as const).map((item) => (
          <button key={item} className={`module-tab${activeTab === item ? " active" : ""}`} onClick={() => setActiveTab(item)}>
            {item}
          </button>
        ))}
      </div>

      {activeTab === "Vendors" ? <VendorsPage /> : null}

      {activeTab === "Purchase Orders" ? (
        <SectionCard title="Purchase Orders">
          <div className="meta-row">
            <span>{purchaseOrders.length.toLocaleString("en-US")} purchase orders loaded</span>
            <span>Confirmed sales orders are split by vendor. Edit before converting to bill.</span>
          </div>
          <DataTable
            rows={purchaseOrders}
            columns={purchaseOrderColumnsWithMarks}
            emptyText="No purchase orders generated yet. Confirm a sales order first."
            onRowClick={(row) => {
              setSelectedPurchaseOrderId(row.id);
              setPurchaseOrderDraft({ ...row, lines: row.lines.map((line) => ({ ...line })) });
            }}
            rowClassName={(row) => (row.id === selectedPurchaseOrderId ? "data-table__row--active" : "")}
          />

          {purchaseOrderDraft ? (
            <div className="invoice-editor-block">
              <div className="invoice-edit-shell">
                <div className="document-marks document-marks--header">
                  <span className={`mark-badge ${purchaseOrderDraft.status === "confirmed" || purchaseOrderDraft.status === "closed" ? "mark-badge--success" : ""}`}>
                    {purchaseOrderDraft.status.toUpperCase()}
                  </span>
                  {(billCountByPurchaseOrderId.get(purchaseOrderDraft.id) || 0) > 0 ? (
                    <span className="mark-badge mark-badge--accent">
                      Bill {(billCountByPurchaseOrderId.get(purchaseOrderDraft.id) || 0).toLocaleString("en-US")} created
                    </span>
                  ) : null}
                </div>
                <div className="invoice-meta-grid">
                  <Input label="PO No" value={purchaseOrderDraft.id} onChange={(value) => setPurchaseOrderDraft((current) => (current ? { ...current, id: value } : current))} />
                  <Input
                    label="Vendor"
                    value={purchaseOrderDraft.supplier_name}
                    onChange={(value) => setPurchaseOrderDraft((current) => (current ? { ...current, supplier_name: value } : current))}
                  />
                  <Input
                    label="Purchase Company"
                    value={purchaseOrderDraft.purchase_company}
                    onChange={(value) => setPurchaseOrderDraft((current) => (current ? { ...current, purchase_company: value } : current))}
                  />
                  <Input label="Sales Order" value={purchaseOrderDraft.sales_order_no} onChange={(value) => setPurchaseOrderDraft((current) => (current ? { ...current, sales_order_no: value } : current))} />
                  <Input label="Customer" value={purchaseOrderDraft.customer_name} onChange={(value) => setPurchaseOrderDraft((current) => (current ? { ...current, customer_name: value } : current))} />
                  <Select
                    label="Status"
                    value={purchaseOrderDraft.status}
                    options={[
                      { value: "draft", label: "Draft" },
                      { value: "confirmed", label: "Confirmed" },
                      { value: "closed", label: "Closed" },
                    ]}
                    onChange={(value) =>
                      setPurchaseOrderDraft((current) => (current ? { ...current, status: value as LocalPurchaseOrder["status"] } : current))
                    }
                  />
                </div>

                <table className="simple-edit-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Stock</th>
                      <th>Buy Price</th>
                      <th>Line Total</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {purchaseOrderDraft.lines.map((line, index) => (
                      <tr key={`${line.product_code}-${index}`}>
                        <td>{line.product_code}</td>
                        <td>{line.description || "-"}</td>
                        <td>
                          <input
                            className="inline-edit-input inline-edit-input--qty"
                            type="number"
                            min={1}
                            step={1}
                            value={line.qty}
                            onChange={(event) =>
                              setPurchaseOrderDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, qty: Math.max(1, Number(event.target.value || 1) || 1) } : item,
                                      ),
                                    }
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>
                          {renderInventoryAvailabilityBadge(inventoryAvailabilityLookup, {
                            brand: line.brand,
                            qty: Number(line.qty || 0) || 0,
                            productCode: line.product_code,
                            oldCode: line.old_code,
                          })}
                        </td>
                        <td>
                          <input
                            className="inline-edit-input inline-edit-input--money"
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.buy_price}
                            onChange={(event) =>
                              setPurchaseOrderDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, buy_price: Number(event.target.value || 0) } : item,
                                      ),
                                    }
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>{formatMoney((Number(line.buy_price || 0) || 0) * (Number(line.qty || 0) || 0), purchaseOrderDraft.currency)}</td>
                        <td>
                          <input
                            className="inline-edit-input"
                            value={line.notes}
                            onChange={(event) =>
                              setPurchaseOrderDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) => (itemIndex === index ? { ...item, notes: event.target.value } : item)),
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

                <div className="toolbar toolbar--wrap">
                  <Button variant="secondary" onClick={() => handlePrintPurchaseOrder(purchaseOrderDraft)} busy={printingPurchaseOrder} busyLabel="Opening PDF...">
                    PDF / Print
                  </Button>
                  <Button variant="secondary" onClick={() => handleExportPurchaseOrderExcel(purchaseOrderDraft)}>
                    Export Excel
                  </Button>
                  <Button onClick={savePurchaseOrderDraft}>Save Purchase Order</Button>
                  <Button variant="secondary" onClick={convertPurchaseOrderToBill}>
                    Convert to Bill
                  </Button>
                  <Button variant="secondary" onClick={handleDeletePurchaseOrder}>
                    Delete Purchase Order
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {activeTab === "Bills" ? (
        <SectionCard title="Bills">
          <div className="meta-row">
            <span>{bills.length.toLocaleString("en-US")} bills loaded</span>
            <span>Bills are generated from purchase orders and remain editable before confirmation.</span>
          </div>
          <DataTable
            rows={bills}
            columns={billColumns}
            emptyText="No bills yet. Convert a purchase order first."
            onRowClick={(row) => {
              setSelectedBillId(row.id);
              setBillDraft({ ...row, lines: row.lines.map((line) => ({ ...line })) });
            }}
            rowClassName={(row) => (row.id === selectedBillId ? "data-table__row--active" : "")}
          />

          {billDraft ? (
            <div className="invoice-editor-block">
              <div className="invoice-edit-shell">
                <div className="invoice-meta-grid">
                  <Input label="Bill No" value={billDraft.id} onChange={(value) => setBillDraft((current) => (current ? { ...current, id: value } : current))} />
                  <Input label="Purchase Order" value={billDraft.purchase_order_no} onChange={(value) => setBillDraft((current) => (current ? { ...current, purchase_order_no: value } : current))} />
                  <Input label="Vendor" value={billDraft.supplier_name} onChange={(value) => setBillDraft((current) => (current ? { ...current, supplier_name: value } : current))} />
                  <Input label="Bill Date" type="date" value={billDraft.bill_date} onChange={(value) => setBillDraft((current) => (current ? { ...current, bill_date: value } : current))} />
                  <Input label="Due Date" type="date" value={billDraft.due_date} onChange={(value) => setBillDraft((current) => (current ? { ...current, due_date: value } : current))} />
                  <Select
                    label="Status"
                    value={billDraft.status}
                    options={[
                      { value: "draft", label: "Draft" },
                      { value: "confirmed", label: "Confirmed" },
                      { value: "paid", label: "Paid" },
                      { value: "void", label: "Void" },
                    ]}
                    onChange={(value) => setBillDraft((current) => (current ? { ...current, status: value as LocalBill["status"] } : current))}
                  />
                  <Input label="Payment Terms" value={billDraft.payment_terms} onChange={(value) => setBillDraft((current) => (current ? { ...current, payment_terms: value } : current))} />
                  <Input label="Discount" type="number" value={String(billDraft.discount_amount)} onChange={(value) => setBillDraft((current) => (current ? { ...current, discount_amount: Number(value || 0) } : current))} />
                  <Input label="Shipping" type="number" value={String(billDraft.shipping_cost)} onChange={(value) => setBillDraft((current) => (current ? { ...current, shipping_cost: Number(value || 0) } : current))} />
                </div>

                <div className="field field--full">
                  <label className="field__label">Notes</label>
                  <textarea
                    className="field__input field__input--textarea"
                    value={billDraft.notes}
                    onChange={(event) => setBillDraft((current) => (current ? { ...current, notes: event.target.value } : current))}
                  />
                </div>

                <table className="simple-edit-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Stock</th>
                      <th>Buy Price</th>
                      <th>Line Total</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billDraft.lines.map((line, index) => (
                      <tr key={`${line.product_code}-${index}`}>
                        <td>{line.product_code}</td>
                        <td>{line.description || "-"}</td>
                        <td>
                          <input
                            className="inline-edit-input inline-edit-input--qty"
                            type="number"
                            min={1}
                            step={1}
                            value={line.qty}
                            onChange={(event) =>
                              setBillDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, qty: Math.max(1, Number(event.target.value || 1) || 1) } : item,
                                      ),
                                    }
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>
                          {renderInventoryAvailabilityBadge(inventoryAvailabilityLookup, {
                            brand: line.brand,
                            qty: Number(line.qty || 0) || 0,
                            productCode: line.product_code,
                            oldCode: line.old_code,
                          })}
                        </td>
                        <td>
                          <input
                            className="inline-edit-input inline-edit-input--money"
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.buy_price}
                            onChange={(event) =>
                              setBillDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) =>
                                        itemIndex === index ? { ...item, buy_price: Number(event.target.value || 0) } : item,
                                      ),
                                    }
                                  : current,
                              )
                            }
                          />
                        </td>
                        <td>{formatMoney((Number(line.buy_price || 0) || 0) * (Number(line.qty || 0) || 0), billDraft.currency)}</td>
                        <td>
                          <input
                            className="inline-edit-input"
                            value={line.notes}
                            onChange={(event) =>
                              setBillDraft((current) =>
                                current
                                  ? {
                                      ...current,
                                      lines: current.lines.map((item, itemIndex) => (itemIndex === index ? { ...item, notes: event.target.value } : item)),
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

                <div className="toolbar toolbar--wrap">
                  <div className="meta-row">
                    <span>Subtotal: {formatMoney(recomputeBillTotals(billDraft).subtotal, billDraft.currency)}</span>
                    <span>Total: {formatMoney(recomputeBillTotals(billDraft).total_amount, billDraft.currency)}</span>
                  </div>
                  <Button variant="secondary" onClick={() => handlePrintBill(billDraft)} busy={printingBill} busyLabel="Opening PDF...">
                    PDF / Print
                  </Button>
                  <Button onClick={saveBillDraft}>Save Bill</Button>
                  <Button variant="secondary" onClick={() => handleAddPaymentMade(billDraft)}>
                    Add Payment
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {activeTab === "Payments Made" ? (
        <SectionCard title="Payments Made">
          <div className="meta-row">
            <span>{paymentsMade.length.toLocaleString("en-US")} payments loaded</span>
            <span>Record settlements against vendor bills.</span>
          </div>
          <div className="toolbar toolbar--wrap">
            <Button onClick={() => handleAddPaymentMade()}>+ Add Payment Made</Button>
          </div>
          <DataTable
            rows={paymentsMade}
            columns={paymentMadeColumns}
            emptyText="No vendor payments yet."
            onRowClick={(row) => {
              setSelectedPaymentMadeId(row.id);
              setPaymentMadeDraft({ ...row });
            }}
            rowClassName={(row) => (row.id === selectedPaymentMadeId ? "data-table__row--active" : "")}
          />
          {paymentMadeDraft ? (
            <div className="invoice-editor-block">
              <div className="invoice-edit-shell">
                <div className="invoice-meta-grid">
                  <Input label="Payment No" value={paymentMadeDraft.id} onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, id: value } : current))} />
                  <label className="field">
                    <span className="field__label">Bill</span>
                    <select
                      className="field__input"
                      value={paymentMadeDraft.bill_id}
                      onChange={(event) => {
                        const bill = bills.find((item) => item.id === event.target.value) || null;
                        setPaymentMadeDraft((current) =>
                          current
                            ? {
                                ...current,
                                bill_id: bill?.id || "",
                                bill_no: bill?.id || "",
                                supplier_name: bill?.supplier_name || current.supplier_name,
                                purchase_company: bill?.purchase_company || current.purchase_company,
                                currency: bill?.currency || current.currency,
                                amount: bill ? Number(bill.total_amount || 0) : current.amount,
                              }
                            : current,
                        );
                      }}
                    >
                      <option value="">Manual / Unlinked</option>
                      {bills.map((bill) => (
                        <option key={bill.id} value={bill.id}>
                          {bill.id} - {bill.supplier_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Input label="Bill No" value={paymentMadeDraft.bill_no} onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, bill_no: value } : current))} />
                  <Input label="Vendor" value={paymentMadeDraft.supplier_name} onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, supplier_name: value } : current))} />
                  <Input label="Payment Date" type="date" value={paymentMadeDraft.payment_date} onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, payment_date: value } : current))} />
                  <Input label="Amount" type="number" value={String(paymentMadeDraft.amount)} onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, amount: Number(value || 0) } : current))} />
                  <Select
                    label="Method"
                    value={paymentMadeDraft.method}
                    options={[
                      { value: "Bank Transfer", label: "Bank Transfer" },
                      { value: "Cash", label: "Cash" },
                      { value: "Credit Card", label: "Credit Card" },
                      { value: "Cheque", label: "Cheque" },
                    ]}
                    onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, method: value } : current))}
                  />
                  <Input label="Reference No" value={paymentMadeDraft.reference_no} onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, reference_no: value } : current))} />
                  <Select
                    label="Status"
                    value={paymentMadeDraft.status}
                    options={[
                      { value: "draft", label: "Draft" },
                      { value: "confirmed", label: "Confirmed" },
                      { value: "void", label: "Void" },
                    ]}
                    onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, status: value as LocalPaymentMade["status"] } : current))}
                  />
                  <Input label="Currency" value={paymentMadeDraft.currency} onChange={(value) => setPaymentMadeDraft((current) => (current ? { ...current, currency: value } : current))} />
                </div>
                <div className="field field--full">
                  <label className="field__label">Notes</label>
                  <textarea className="field__input field__input--textarea" value={paymentMadeDraft.notes} onChange={(event) => setPaymentMadeDraft((current) => (current ? { ...current, notes: event.target.value } : current))} />
                </div>
                <div className="toolbar toolbar--wrap">
                  <Button onClick={savePaymentMadeDraft}>Save Payment</Button>
                  <Button variant="secondary" onClick={() => setPaymentMadeDraft((current) => (current ? { ...current, status: "confirmed" } : current))}>
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
