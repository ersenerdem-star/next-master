import { useEffect, useMemo, useState } from "react";
import { normalizePartCode } from "../../domain/shared/normalize";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchBills, fetchInvoices, fetchPurchaseOrders, fetchSalesOrders } from "../../infrastructure/api/ordersApi";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import type { LocalBill, LocalInvoice, LocalPurchaseOrder, LocalSalesOrder } from "../../types/orders";
import { DataTable } from "../components/common/DataTable";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";

type ItemTransactionRow = {
  date: string;
  document_type: "Sales Order" | "Purchase Order" | "Invoice" | "Bill";
  direction: "IN" | "OUT";
  document_no: string;
  reference_no: string;
  status: string;
  party_name: string;
  brand: string;
  product_code: string;
  description: string;
  qty: number;
  unit_price: number;
  amount: number;
};

type ItemTransactionSummaryRow = {
  brand: string;
  product_code: string;
  description: string;
  inbound_qty: number;
  outbound_qty: number;
  net_qty: number;
  inbound_amount: number;
  outbound_amount: number;
  net_amount: number;
  movement_count: number;
  last_movement_date: string;
};

function toNumber(value: number | null | undefined) {
  return Number(value ?? 0) || 0;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function formatQty(value: number) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function itemTransactionKey(brand: string, productCode: string) {
  return `${String(brand || "").trim().toLowerCase()}::${normalizePartCode(productCode)}`;
}

function salesOrderRows(orders: LocalSalesOrder[]): ItemTransactionRow[] {
  return orders.flatMap((order) =>
    order.lines.map((line) => ({
      date: order.quote_date || order.updated_at.slice(0, 10),
      document_type: "Sales Order",
      direction: "OUT",
      document_no: order.sales_order_no,
      reference_no: order.id,
      status: order.status,
      party_name: order.customer_name,
      brand: line.brand || "",
      product_code: line.resolvedCode || line.requestedCode || "",
      description: line.description || "",
      qty: line.qty,
      unit_price: toNumber(line.sell_price),
      amount: roundMoney(toNumber(line.sell_price) * line.qty),
    })),
  );
}

function purchaseOrderRows(orders: LocalPurchaseOrder[]): ItemTransactionRow[] {
  return orders.flatMap((order) =>
    order.lines.map((line) => ({
      date: String(order.created_at || "").slice(0, 10),
      document_type: "Purchase Order",
      direction: "IN",
      document_no: order.id,
      reference_no: order.sales_order_no,
      status: order.status,
      party_name: order.supplier_name,
      brand: line.brand || "",
      product_code: line.product_code || line.old_code || "",
      description: line.description || "",
      qty: line.qty,
      unit_price: toNumber(line.buy_price),
      amount: roundMoney(toNumber(line.line_total)),
    })),
  );
}

function invoiceRows(invoices: LocalInvoice[]): ItemTransactionRow[] {
  return invoices.flatMap((invoice) =>
    invoice.lines.map((line) => ({
      date: invoice.quote_date || invoice.updated_at.slice(0, 10),
      document_type: "Invoice",
      direction: "OUT",
      document_no: invoice.id,
      reference_no: invoice.sales_order_no,
      status: invoice.status,
      party_name: invoice.customer_name,
      brand: line.brand || "",
      product_code: line.product_code || line.old_code || "",
      description: line.description || "",
      qty: line.qty,
      unit_price: toNumber(line.sell_price),
      amount: roundMoney(toNumber(line.sales_total)),
    })),
  );
}

function billRows(bills: LocalBill[]): ItemTransactionRow[] {
  return bills.flatMap((bill) =>
    bill.lines.map((line) => ({
      date: bill.bill_date || bill.updated_at.slice(0, 10),
      document_type: "Bill",
      direction: "IN",
      document_no: bill.id,
      reference_no: bill.purchase_order_no,
      status: bill.status,
      party_name: bill.supplier_name,
      brand: line.brand || "",
      product_code: line.product_code || line.old_code || "",
      description: line.description || "",
      qty: line.qty,
      unit_price: toNumber(line.buy_price),
      amount: roundMoney(toNumber(line.line_total)),
    })),
  );
}

export function ItemTransactionsPage() {
  const actionFeedback = useActionFeedback();
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [rows, setRows] = useState<ItemTransactionRow[]>([]);
  const [brandOptions, setBrandOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [brand, setBrand] = useState("");
  const [codeSearch, setCodeSearch] = useState("");
  const [partySearch, setPartySearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const brands = await fetchCloudBrands();
        if (cancelled) return;
        setBrandOptions([{ value: "", label: "All Brands" }, ...brands.map((item) => ({ value: item.name, label: item.name }))]);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Item transactions load failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback]);

  async function handleLoad() {
    if (!brand && !codeSearch.trim()) {
      actionFeedback.fail("Select a brand or enter a code first.");
      return;
    }

    try {
      setLoading(true);
      setLoaded(true);
      actionFeedback.begin("Loading item transactions...");
      const [salesOrders, purchaseOrders, invoices, bills] = await Promise.all([
        fetchSalesOrders(),
        fetchPurchaseOrders(),
        fetchInvoices(),
        fetchBills(),
      ]);
      setRows([
        ...salesOrderRows(salesOrders),
        ...purchaseOrderRows(purchaseOrders),
        ...invoiceRows(invoices),
        ...billRows(bills),
      ]);
      actionFeedback.succeed("Item transactions loaded.");
    } catch (caught) {
      setRows([]);
      actionFeedback.fail(caught instanceof Error ? caught.message : "Item transactions load failed");
    } finally {
      setLoading(false);
    }
  }

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (brand && row.brand.trim().toLowerCase() !== brand.trim().toLowerCase()) return false;
      if (codeSearch.trim()) {
        const rawNeedle = codeSearch.trim().toLowerCase();
        const normalizedNeedle = normalizePartCode(codeSearch);
        const haystack = `${row.product_code} ${row.description}`.toLowerCase();
        const normalizedCode = normalizePartCode(row.product_code);
        if (!haystack.includes(rawNeedle) && (!normalizedNeedle || !normalizedCode.includes(normalizedNeedle))) return false;
      }
      if (partySearch.trim() && !row.party_name.toLowerCase().includes(partySearch.trim().toLowerCase())) return false;
      if (dateFrom && row.date && row.date < dateFrom) return false;
      if (dateTo && row.date && row.date > dateTo) return false;
      return true;
    });
  }, [rows, brand, codeSearch, partySearch, dateFrom, dateTo]);

  const summaryRows = useMemo<ItemTransactionSummaryRow[]>(() => {
    const map = new Map<string, ItemTransactionSummaryRow>();
    filteredRows.forEach((row) => {
      const key = itemTransactionKey(row.brand, row.product_code);
      const existing = map.get(key) || {
        brand: row.brand || "",
        product_code: row.product_code || "",
        description: row.description || "",
        inbound_qty: 0,
        outbound_qty: 0,
        net_qty: 0,
        inbound_amount: 0,
        outbound_amount: 0,
        net_amount: 0,
        movement_count: 0,
        last_movement_date: "",
      };
      if (!existing.description && row.description) existing.description = row.description;
      if (row.direction === "IN") {
        existing.inbound_qty += row.qty;
        existing.inbound_amount += row.amount;
      } else {
        existing.outbound_qty += row.qty;
        existing.outbound_amount += row.amount;
      }
      existing.net_qty = existing.inbound_qty - existing.outbound_qty;
      existing.net_amount = roundMoney(existing.inbound_amount - existing.outbound_amount);
      existing.movement_count += 1;
      if (!existing.last_movement_date || row.date > existing.last_movement_date) {
        existing.last_movement_date = row.date;
      }
      map.set(key, existing);
    });
    return [...map.values()]
      .map((row) => ({
        ...row,
        inbound_amount: roundMoney(row.inbound_amount),
        outbound_amount: roundMoney(row.outbound_amount),
        net_amount: roundMoney(row.net_amount),
      }))
      .sort((a, b) => a.brand.localeCompare(b.brand) || a.product_code.localeCompare(b.product_code));
  }, [filteredRows]);

  const historyRows = useMemo(() => {
    return [...filteredRows].sort((left, right) => {
      if (left.date !== right.date) return right.date.localeCompare(left.date);
      if (left.document_type !== right.document_type) return left.document_type.localeCompare(right.document_type);
      return left.document_no.localeCompare(right.document_no);
    });
  }, [filteredRows]);

  const inboundAmount = useMemo(() => roundMoney(summaryRows.reduce((sum, row) => sum + row.inbound_amount, 0)), [summaryRows]);
  const outboundAmount = useMemo(() => roundMoney(summaryRows.reduce((sum, row) => sum + row.outbound_amount, 0)), [summaryRows]);
  const netQty = useMemo(() => summaryRows.reduce((sum, row) => sum + row.net_qty, 0), [summaryRows]);

  const columns = useMemo(
    () => [
      { key: "brand", header: "Brand", render: (row: ItemTransactionSummaryRow) => row.brand || "-" },
      { key: "code", header: "Code", render: (row: ItemTransactionSummaryRow) => row.product_code || "-" },
      { key: "description", header: "Description", render: (row: ItemTransactionSummaryRow) => row.description || "-" },
      { key: "inqty", header: "In Qty", render: (row: ItemTransactionSummaryRow) => row.inbound_qty.toLocaleString("en-US") },
      { key: "outqty", header: "Out Qty", render: (row: ItemTransactionSummaryRow) => row.outbound_qty.toLocaleString("en-US") },
      { key: "netqty", header: "Net Qty", render: (row: ItemTransactionSummaryRow) => row.net_qty.toLocaleString("en-US") },
      { key: "inamount", header: "In Amount", render: (row: ItemTransactionSummaryRow) => formatMoney(row.inbound_amount) },
      { key: "outamount", header: "Out Amount", render: (row: ItemTransactionSummaryRow) => formatMoney(row.outbound_amount) },
      { key: "netamount", header: "Net Amount", render: (row: ItemTransactionSummaryRow) => formatMoney(row.net_amount) },
      { key: "moves", header: "Moves", render: (row: ItemTransactionSummaryRow) => row.movement_count.toLocaleString("en-US") },
      { key: "last", header: "Last Movement", render: (row: ItemTransactionSummaryRow) => row.last_movement_date || "-" },
    ],
    [],
  );

  const historyColumns = useMemo(
    () => [
      { key: "date", header: "Date", render: (row: ItemTransactionRow) => row.date || "-" },
      { key: "type", header: "Document", render: (row: ItemTransactionRow) => row.document_type || "-" },
      { key: "docno", header: "No", render: (row: ItemTransactionRow) => row.document_no || "-" },
      { key: "status", header: "Status", render: (row: ItemTransactionRow) => row.status || "-" },
      {
        key: "direction",
        header: "Flow",
        render: (row: ItemTransactionRow) => (row.direction === "IN" ? "Bought" : "Sold"),
      },
      {
        key: "party",
        header: "Party",
        render: (row: ItemTransactionRow) => row.party_name || "-",
      },
      { key: "brand", header: "Brand", render: (row: ItemTransactionRow) => row.brand || "-" },
      { key: "code", header: "Code", render: (row: ItemTransactionRow) => row.product_code || "-" },
      { key: "description", header: "Description", render: (row: ItemTransactionRow) => row.description || "-" },
      { key: "qtyin", header: "Qty In", render: (row: ItemTransactionRow) => (row.direction === "IN" ? formatQty(row.qty) : "-") },
      { key: "qtyout", header: "Qty Out", render: (row: ItemTransactionRow) => (row.direction === "OUT" ? formatQty(row.qty) : "-") },
      { key: "price", header: "Unit Price", render: (row: ItemTransactionRow) => formatMoney(row.unit_price) },
      { key: "amount", header: "Amount", render: (row: ItemTransactionRow) => formatMoney(row.amount) },
    ],
    [],
  );

  async function handleExportExcel() {
    try {
      setExporting(true);
      actionFeedback.begin("Preparing item transactions export...");
      const sheetRows: Array<Array<string | number>> = [
        ["Brand", "Code", "Description", "In_Qty", "Out_Qty", "Net_Qty", "In_Amount_EUR", "Out_Amount_EUR", "Net_Amount_EUR", "Moves", "Last_Movement"],
        ...summaryRows.map((row) => [
          row.brand,
          row.product_code,
          row.description,
          row.inbound_qty,
          row.outbound_qty,
          row.net_qty,
          row.inbound_amount,
          row.outbound_amount,
          row.net_amount,
          row.movement_count,
          row.last_movement_date,
        ]),
      ];
      const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const blob = buildXlsxBlob("Item Transactions", sheetRows, [3, 4, 5, 6, 7, 8, 9]);
      downloadBlob(`item-transactions-${brand || "all"}-${stamp}.xlsx`, blob);
      actionFeedback.succeed("Item transactions exported.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Item transactions export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <SectionCard title="Item Transactions">
      <div className="toolbar toolbar--wrap">
        <Select label="Brand" value={brand} options={brandOptions.length ? brandOptions : [{ value: "", label: "All Brands" }]} onChange={setBrand} />
        <Input label="Code / Description" value={codeSearch} onChange={setCodeSearch} />
        <Input label="Customer / Vendor" value={partySearch} onChange={setPartySearch} />
        <Input label="Date From" type="date" value={dateFrom} onChange={setDateFrom} />
        <Input label="Date To" type="date" value={dateTo} onChange={setDateTo} />
        <Button onClick={() => void handleLoad()} busy={loading} busyLabel="Loading...">
          Load Report
        </Button>
        <Button onClick={() => void handleExportExcel()} busy={exporting} busyLabel="Exporting..." disabled={!loaded || !summaryRows.length}>
          Export Excel
        </Button>
      </div>
      <div className="meta-row">
        <span>{summaryRows.length.toLocaleString("en-US")} items</span>
        <span>Net Qty {netQty.toLocaleString("en-US")} | Inbound {formatMoney(inboundAmount)} | Outbound {formatMoney(outboundAmount)}</span>
      </div>
      {loading ? (
        <div className="empty-state">Loading item transactions...</div>
      ) : loaded ? (
        <>
          <DataTable rows={summaryRows} columns={columns} emptyText="No item transactions found for the selected filters." />
          <div className="section-card quote-workbench-card">
            <div className="section-card__header">
              <h2>Item Transaction History</h2>
              <p>Shows who supplied the item and which customer or customers it was sold to.</p>
            </div>
            <div className="section-card__body">
              <div className="meta-row">
                <span>{historyRows.length.toLocaleString("en-US")} movements</span>
                <span>Use code and party filters to narrow item-level history.</span>
              </div>
              <DataTable rows={historyRows} columns={historyColumns} emptyText="No transaction history found for the selected filters." />
            </div>
          </div>
        </>
      ) : (
        <div className="empty-state">Select a brand or enter a code, then load the report.</div>
      )}
    </SectionCard>
  );
}
