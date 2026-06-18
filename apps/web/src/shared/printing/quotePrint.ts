import type { CompanyProfile } from "../../types/company";
import type { QuoteDetail, QuoteLine } from "../../types/quotes";
import { nl2br, safeText } from "../local/companyProfile";

function formatNumber(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
}

function sumLine(lines: QuoteLine[], key: "buy_price" | "sell_price" | "c_sell_price") {
  return lines.reduce((total, line) => {
    const qty = Number(line.qty ?? 0);
    const price = Number(line[key] ?? 0);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return total;
    return total + qty * price;
  }, 0);
}

export function openQuotePrintWindow(profile: CompanyProfile, detail: QuoteDetail) {
  if (typeof window === "undefined" || !detail.quote) return;

  const quote = detail.quote as Record<string, unknown>;
  const quoteNo = safeText(quote.quote_no || "-");
  const customerName = safeText(quote.customer_name || "-");
  const quoteDate = safeText(quote.quote_date || "-");
  const currency = safeText(quote.currency || "EUR");
  const status = safeText(quote.status || "-");
  const salesTotal = Number(quote.sales_total ?? sumLine(detail.lines, "sell_price"));
  const cSalesTotal = sumLine(detail.lines, "c_sell_price");
  const buyTotal = Number(quote.purchase_total ?? sumLine(detail.lines, "buy_price"));

  const rowsHtml = detail.lines
    .map((line) => {
      const total = Number(line.qty ?? 0) * Number(line.sell_price ?? 0);
      return `
        <tr>
          <td>${safeText(line.line_no ?? "-")}</td>
          <td>${safeText(line.product_code || "-")}</td>
          <td>${safeText(line.brand_text || "-")}</td>
          <td>${safeText(line.description || "-")}</td>
          <td>${safeText(line.qty ?? "-")}</td>
          <td>${formatNumber(line.buy_price ?? 0)}</td>
          <td>${formatNumber(line.sell_price ?? 0)}</td>
          <td>${formatNumber(line.c_sell_price ?? 0)}</td>
          <td>${safeText(line.origin || "-")}</td>
          <td>${formatNumber(total)}</td>
        </tr>
      `;
    })
    .join("");

  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${quoteNo} - Sales Order Print</title>
      <style>
        body { margin: 0; padding: 32px; font-family: Inter, Arial, sans-serif; color: #0f172a; background: #ffffff; }
        .sheet { max-width: 1120px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 2px solid #e2e8f0; padding-bottom: 24px; margin-bottom: 24px; }
        .brand { display: flex; gap: 16px; align-items: flex-start; }
        .logo { width: 96px; height: 96px; object-fit: contain; border-radius: 16px; border: 1px solid #e2e8f0; background: #fff; }
        .company h1 { margin: 0 0 8px; font-size: 28px; }
        .company p, .meta p { margin: 4px 0; line-height: 1.45; }
        .meta { min-width: 280px; text-align: right; }
        .grid { display: grid; grid-template-columns: 1.1fr 0.9fr; gap: 20px; margin-bottom: 24px; }
        .card { border: 1px solid #e2e8f0; border-radius: 18px; padding: 18px; }
        .card h3 { margin: 0 0 10px; font-size: 16px; }
        table { width: 100%; border-collapse: collapse; margin-top: 18px; }
        th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 8px; text-align: left; vertical-align: top; font-size: 13px; }
        th { background: #f8fafc; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
        .totals { margin-top: 20px; margin-left: auto; width: 320px; border: 1px solid #e2e8f0; border-radius: 18px; padding: 18px; }
        .totals-row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; }
        .totals-row + .totals-row { border-top: 1px solid #e2e8f0; }
        .footer { margin-top: 28px; color: #475569; font-size: 12px; border-top: 1px solid #e2e8f0; padding-top: 16px; }
      </style>
    </head>
    <body>
      <div class="sheet">
        <div class="header">
          <div class="brand">
            ${profile.logoDataUrl ? `<img class="logo" src="${profile.logoDataUrl}" alt="Company logo" />` : ""}
            <div class="company">
              <h1>${safeText(profile.companyName || "Company Profile")}</h1>
              <p>${nl2br(profile.address || "")}</p>
              <p>${safeText(profile.phone || "")}</p>
              <p>${safeText(profile.email || "")}</p>
              <p>${safeText(profile.website || "")}</p>
              <p>Tax Office: ${safeText(profile.taxOffice || "-")}</p>
              <p>Tax Number: ${safeText(profile.taxNumber || "-")}</p>
            </div>
          </div>
          <div class="meta">
            <h1 style="margin:0 0 8px; font-size:28px;">Sales Order</h1>
            <p><strong>Sales Order No:</strong> ${quoteNo}</p>
            <p><strong>Date:</strong> ${quoteDate}</p>
            <p><strong>Status:</strong> ${status}</p>
            <p><strong>Currency:</strong> ${currency}</p>
            <p><strong>Customer:</strong> ${customerName}</p>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Line</th><th>Code</th><th>Brand</th><th>Description</th><th>Qty</th><th>Buy</th><th>Sell</th><th>C Sell</th><th>Origin</th><th>Total</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="totals">
          <div class="totals-row"><span>Purchase Total</span><strong>${formatNumber(buyTotal)}</strong></div>
          <div class="totals-row"><span>Sales Total</span><strong>${formatNumber(salesTotal)}</strong></div>
          <div class="totals-row"><span>C Sales Total</span><strong>${formatNumber(cSalesTotal)}</strong></div>
        </div>
        ${profile.footerNote ? `<div class="footer">${nl2br(profile.footerNote)}</div>` : ""}
      </div>
      <script>window.onload = () => window.print();</script>
    </body>
  </html>`;

  const printWindow = window.open("", "_blank", "noopener,noreferrer,width=1280,height=900");
  if (!printWindow) return;
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
