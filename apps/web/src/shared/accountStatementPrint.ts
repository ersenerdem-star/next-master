import type { CompanyProfile } from "../types/company";

export type StatementPeriodType = "monthly" | "quarterly" | "yearly";

export type AccountStatementRow = {
  document_type?: string;
  date: string;
  document_no: string;
  due_date?: string;
  status: string;
  currency: string;
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
};

export function isDateInStatementPeriod(value: string, periodType: StatementPeriodType, anchorDate: string) {
  const target = new Date(value || "");
  const anchor = new Date(anchorDate || "");
  if (Number.isNaN(target.getTime()) || Number.isNaN(anchor.getTime())) return false;

  const targetYear = target.getUTCFullYear();
  const anchorYear = anchor.getUTCFullYear();
  if (targetYear !== anchorYear && periodType !== "yearly") {
    if (periodType === "quarterly" || periodType === "monthly") return false;
  }

  if (periodType === "yearly") {
    return targetYear === anchorYear;
  }

  const targetMonth = target.getUTCMonth();
  const anchorMonth = anchor.getUTCMonth();
  if (periodType === "monthly") {
    return targetYear === anchorYear && targetMonth === anchorMonth;
  }

  const targetQuarter = Math.floor(targetMonth / 3);
  const anchorQuarter = Math.floor(anchorMonth / 3);
  return targetYear === anchorYear && targetQuarter === anchorQuarter;
}

export function getStatementPeriodLabel(periodType: StatementPeriodType, anchorDate: string) {
  const anchor = new Date(anchorDate || "");
  if (Number.isNaN(anchor.getTime())) return "";
  const year = anchor.getUTCFullYear();
  const month = anchor.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  if (periodType === "yearly") return `${year}`;
  if (periodType === "monthly") return `${month} ${year}`;
  return `Q${Math.floor(anchor.getUTCMonth() / 3) + 1} ${year}`;
}

function safeText(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtMoney(value: number, currency: string) {
  return `${Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

export function openAccountStatementPrintWindow(input: {
  title: string;
  company: CompanyProfile | null;
  partyName: string;
  billingAddress: string;
  shippingAddress?: string;
  periodLabel: string;
  rows: AccountStatementRow[];
}) {
  const popup = window.open("", "_blank", "noopener,noreferrer");
  if (!popup) {
    throw new Error("Popup blocked while opening statement view.");
  }

  const company = input.company;
  const primaryCurrency = input.rows[0]?.currency || "EUR";
  const subtotal = input.rows.reduce((sum, row) => sum + Number(row.subtotal || 0), 0);
  const discount = input.rows.reduce((sum, row) => sum + Number(row.discount || 0), 0);
  const shipping = input.rows.reduce((sum, row) => sum + Number(row.shipping || 0), 0);
  const total = input.rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const shippingBlock = input.shippingAddress?.trim()
    ? `<div class="box"><div class="box-title">Ship To</div><div>${safeText(input.shippingAddress).replaceAll("\n", "<br />")}</div></div>`
    : "";

  popup.document.write(`<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${safeText(input.title)}</title>
      <style>
        body { font-family: Arial, sans-serif; color:#1f2937; margin:28px; font-size:12px; }
        .header { display:grid; grid-template-columns: 1fr auto; gap:28px; align-items:start; margin-bottom:18px; }
        .header-top { font-size:11px; color:#475569; }
        .logo { max-height:70px; max-width:140px; object-fit:contain; display:block; margin-left:auto; }
        .doc-title { font-size:26px; font-weight:700; line-height:1.1; margin-top:10px; text-align:right; }
        .doc-subtitle { text-align:right; color:#64748b; font-size:12px; }
        .party-grid { display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin:18px 0; }
        .box { border:1px solid #dbe3ef; border-radius:10px; padding:12px; min-height:80px; }
        .box-title { font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:#64748b; margin-bottom:8px; font-weight:700; }
        .meta { margin:0 0 18px; font-size:12px; color:#334155; }
        table { width:100%; border-collapse:collapse; margin-top:10px; }
        th, td { border:1px solid #dbe3ef; padding:7px 8px; text-align:left; vertical-align:top; }
        th { background:#f8fafc; font-size:11px; text-transform:uppercase; color:#475569; }
        .num { text-align:right; white-space:nowrap; }
        .summary { width:420px; margin-left:auto; margin-top:18px; border:1px solid #dbe3ef; border-radius:12px; overflow:hidden; }
        .summary-row { display:grid; grid-template-columns:1fr auto; gap:16px; padding:10px 14px; border-top:1px solid #e2e8f0; }
        .summary-row:first-child { border-top:none; }
        .summary-row.total { font-weight:700; font-size:16px; background:#f8fafc; }
        .footer { margin-top:28px; padding-top:14px; border-top:1px solid #dbe3ef; font-size:11px; color:#475569; }
      </style>
    </head>
    <body>
      <div class="header">
        <div>
          <div class="header-top">${safeText(company?.companyName || "")}</div>
          <div class="header-top">${safeText(company?.address || "")}${company?.taxNumber ? ` • Tax ID ${safeText(company.taxNumber)}` : ""}</div>
        </div>
        <div>
          ${company?.logoDataUrl ? `<img class="logo" src="${company.logoDataUrl}" alt="Company logo" />` : ""}
          <div class="doc-title">${safeText(input.title)}</div>
          <div class="doc-subtitle">${safeText(input.periodLabel)}</div>
        </div>
      </div>
      <div class="party-grid">
        <div class="box">
          <div class="box-title">Bill To</div>
          <div><strong>${safeText(input.partyName)}</strong></div>
          <div>${safeText(input.billingAddress || "").replaceAll("\n", "<br />")}</div>
        </div>
        ${shippingBlock}
      </div>
      <div class="meta">Statement period: ${safeText(input.periodLabel)}</div>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Document</th>
            <th>Due Date</th>
            <th>Status</th>
            <th class="num">Subtotal</th>
            <th class="num">Discount</th>
            <th class="num">Shipping</th>
            <th class="num">Total</th>
          </tr>
        </thead>
        <tbody>
          ${input.rows
            .map(
              (row) => `<tr>
                <td>${safeText(row.date || "-")}</td>
                <td>${safeText(row.document_type || "Document")}</td>
                <td>${safeText(row.document_no || "-")}</td>
                <td>${safeText(row.due_date || "-")}</td>
                <td>${safeText(row.status || "-")}</td>
                <td class="num">${fmtMoney(row.subtotal, row.currency)}</td>
                <td class="num">${fmtMoney(row.discount, row.currency)}</td>
                <td class="num">${fmtMoney(row.shipping, row.currency)}</td>
                <td class="num">${fmtMoney(row.total, row.currency)}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <div class="summary">
        <div class="summary-row"><span>Subtotal</span><strong>${fmtMoney(subtotal, primaryCurrency)}</strong></div>
        <div class="summary-row"><span>Discount</span><strong>${fmtMoney(discount, primaryCurrency)}</strong></div>
        <div class="summary-row"><span>Shipping</span><strong>${fmtMoney(shipping, primaryCurrency)}</strong></div>
        <div class="summary-row total"><span>Total Amount</span><strong>${fmtMoney(total, primaryCurrency)}</strong></div>
      </div>
      <div class="footer">
        <div>${safeText(company?.companyName || "")}</div>
        <div>${safeText(company?.address || "")}</div>
        <div>${safeText(company?.bankDetails || "")}</div>
      </div>
      <script>window.onload = () => window.print();</script>
    </body>
  </html>`);
  popup.document.close();
}
