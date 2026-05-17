type PrintCompany = {
  companyName: string;
  address: string;
  bankDetails: string;
  taxNumber: string;
  logoDataUrl: string;
};

type PrintParty = {
  title: string;
  details: string;
  shippingTitle?: string;
  shippingDetails?: string;
};

type PrintMetaItem = {
  label: string;
  value: string;
};

type PrintLine = {
  code: string;
  description: string;
  origin?: string;
  brand?: string;
  orderNo?: string;
  weight?: string;
  gtip?: string;
  qty: number;
  unitPrice: number;
  amount: number;
};

type PrintTotals = {
  currency: string;
  subtotal?: number;
  discount?: number;
  shipping?: number;
  total: number;
};

type BuildBusinessDocumentInput = {
  docType: string;
  docNo: string;
  company: PrintCompany;
  party: PrintParty;
  meta: PrintMetaItem[];
  lines: PrintLine[];
  totals: PrintTotals;
  notes?: string;
  totalQty?: number;
  totalWeight?: number | null;
};

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

const currencyFormatterCache = new Map<string, Intl.NumberFormat>();

function formatMoney(value: number, currency = "EUR") {
  let formatter = currencyFormatterCache.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    currencyFormatterCache.set(currency, formatter);
  }
  return formatter.format(Number(value || 0));
}

export function buildBusinessDocumentHtml(input: BuildBusinessDocumentInput) {
  const currency = input.totals.currency || "EUR";
  const logo = input.company.logoDataUrl
    ? `<img src="${safeText(input.company.logoDataUrl)}" alt="Logo" style="max-height:52px; max-width:138px; object-fit:contain;" />`
    : "";
  const footerLine = [input.company.address || "", input.company.taxNumber ? `Tax ID: ${input.company.taxNumber}` : ""]
    .filter(Boolean)
    .join("   ");
  const showShipping = Boolean(input.party.shippingDetails && input.party.shippingDetails.trim());
  const totalQty = input.totalQty ?? input.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
  const totalWeight = input.totalWeight ?? null;
  const rowsHtml = input.lines
    .map(
      (line) => `
        <tr>
          <td>${safeText(line.code)}</td>
          <td>${safeText(line.description)}</td>
          <td>${safeText(line.origin || "")}</td>
          <td>${safeText(line.brand || "")}</td>
          <td>${safeText(line.orderNo || "")}</td>
          <td>${safeText(line.weight || "")}</td>
          <td>${safeText(line.gtip || "")}</td>
          <td>${safeText(line.qty)}</td>
          <td>${formatMoney(line.unitPrice, currency)}</td>
          <td>${formatMoney(line.amount, currency)}</td>
        </tr>
      `,
    )
    .join("");
  const metaRows = input.meta
    .map(
      (item) => `
        <div class="doc-meta-row">
          <div class="doc-meta-label">${safeText(item.label)}</div>
          <div class="doc-meta-value">${safeText(item.value || "-")}</div>
        </div>
      `,
    )
    .join("");
  const totalsRows = [
    typeof input.totals.subtotal === "number"
      ? `<div class="totals-row"><span>Sub Total</span><strong>${formatMoney(input.totals.subtotal, currency)}</strong></div>`
      : "",
    typeof input.totals.discount === "number"
      ? `<div class="totals-row"><span>Discount</span><strong>${formatMoney(input.totals.discount, currency)}</strong></div>`
      : "",
    typeof input.totals.shipping === "number"
      ? `<div class="totals-row"><span>Shipping & Handling</span><strong>${formatMoney(input.totals.shipping, currency)}</strong></div>`
      : "",
    `<div class="totals-row grand"><span>Total Amount ${safeText(currency)}</span><strong>${formatMoney(input.totals.total, currency)}</strong></div>`,
  ]
    .filter(Boolean)
    .join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${safeText(input.docNo || input.docType)}</title>
      <style>
        @page { margin: 14mm 12mm 18mm; }
        body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111827; margin: 0; font-size: 8.6pt; }
        .page { padding: 0; }
        .header-shell { display:grid; grid-template-columns: 118mm 60mm; gap:8mm; align-items:start; margin-bottom:4mm; }
        .header-left { display:flex; flex-direction:column; gap:3mm; align-items:flex-start; }
        .header-right { display:flex; justify-content:flex-end; }
        .header-card { border:0.25mm solid #d7dee8; border-radius:5px; padding:3mm 3.5mm; background:#fff; box-sizing:border-box; }
        .seller-card { width:56mm; }
        .party-card { width:118mm; }
        .meta-card { width:60mm; min-width:60mm; max-width:60mm; min-height:100%; margin-left:auto; }
        .identity-row { display:flex; flex-direction:column; align-items:center; gap:1.5mm; width:100%; }
        .header-logo { width:100%; min-height:14mm; display:flex; justify-content:center; align-items:flex-start; }
        .seller-name { width:100%; text-align:center; font-size:7.1pt; font-weight:700; line-height:1.22; letter-spacing:0.01em; }
        .billto-title { font-size:6.9pt; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0 0 1.5mm; }
        .billto-grid { display:grid; grid-template-columns: 1fr 1fr; gap:4mm; width:100%; align-items:start; }
        .billto-box { font-size:7.5pt; line-height:1.4; white-space:pre-wrap; }
        .doc-top { display:flex; justify-content:flex-end; margin-bottom:2mm; }
        .doc-heading { text-align:right; width:100%; }
        .doc-eyebrow { font-size:6.8pt; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#6b7280; margin-bottom:1mm; }
        .doc-title { font-size:11pt; font-weight:700; line-height:1.1; margin:0; letter-spacing:-0.01em; word-break:break-word; }
        .doc-meta { display:flex; flex-direction:column; gap:1.2mm; width:100%; }
        .doc-meta-row { display:grid; grid-template-columns: 21mm 1fr; gap:2mm; align-items:start; }
        .doc-meta-label { font-size:6.9pt; font-weight:700; letter-spacing:0.03em; text-transform:uppercase; color:#475569; white-space:nowrap; }
        .doc-meta-value { font-size:7.4pt; font-weight:500; color:#111827; word-break:break-word; line-height:1.25; }
        table { width:100%; border-collapse:collapse; margin-top:4mm; page-break-inside:auto; table-layout:fixed; }
        thead { display:table-header-group; }
        tfoot { display:table-footer-group; }
        tr { page-break-inside:avoid; page-break-after:auto; }
        th, td { border:0.25mm solid #d7dee8; padding:1.5mm 1.7mm; text-align:left; vertical-align:top; font-size:7.2pt; overflow-wrap:anywhere; }
        th { background:#f4f7fa; font-weight:700; line-height:1.18; }
        td:nth-child(8), td:nth-child(9), td:nth-child(10),
        th:nth-child(8), th:nth-child(9), th:nth-child(10) { text-align:right; }
        .totals { display:flex; justify-content:space-between; align-items:flex-start; gap:6mm; margin-top:4mm; }
        .totals-note { flex:1; min-height:10mm; font-size:7.4pt; line-height:1.42; padding-top:0.5mm; }
        .totals-card { min-width:60mm; max-width:68mm; }
        .totals-row { display:flex; justify-content:space-between; gap:4mm; padding:0.8mm 0; font-size:7.6pt; }
        .totals-row strong { font-size:8.3pt; }
        .grand { border-top:1px solid #9ca3af; margin-top:1.5mm; padding-top:2mm; }
        .footer { margin-top:5mm; line-height:1.5; white-space:pre-wrap; border-top:1px solid #d5dbe5; padding-top:2.5mm; }
        .footer-company-meta { font-size:7pt; color:#475569; line-height:1.4; white-space:pre-wrap; }
        .signature-grid { display:grid; grid-template-columns:1fr 1fr; gap:10mm; margin-top:7mm; }
        .signature-box { padding-top:6mm; border-top:1px solid #9ca3af; text-align:center; font-weight:700; font-size:7.4pt; }
        .page-counter { position:fixed; right:0; bottom:0; font-size:6.9pt; color:#64748b; letter-spacing:0.03em; }
        .page-counter::before { content:"Page " counter(page) " / " attr(data-total-pages); }
        @media screen {
          body { margin: 24px 28px 46px; }
          .page-counter::before { content:"Page 1 / " attr(data-total-pages); }
        }
      </style>
    </head>
    <body>
      <div class="page">
        <div class="header-shell">
          <div class="header-left">
            <div class="header-card seller-card">
              <div class="identity-row">
                <div class="header-logo">${logo}</div>
                <div class="seller-name">${safeText(input.company.companyName || "")}</div>
              </div>
            </div>
            <div class="header-card party-card">
              <div class="billto-grid" style="${showShipping ? "" : "grid-template-columns: 1fr;"}">
                <div>
                  <div class="billto-title">${safeText(input.party.title)}</div>
                  <div class="billto-box">${safeMultiline(input.party.details)}</div>
                </div>
                ${showShipping ? `<div>
                  <div class="billto-title">${safeText(input.party.shippingTitle || "Shipping Address")}</div>
                  <div class="billto-box">${safeMultiline(input.party.shippingDetails || "")}</div>
                </div>` : ""}
              </div>
            </div>
          </div>
          <div class="header-right">
            <div class="header-card meta-card">
              <div class="doc-top">
                <div class="doc-heading">
                  <div class="doc-eyebrow">${safeText(input.docType)}</div>
                  <div class="doc-title"># ${safeText(input.docNo)}</div>
                </div>
              </div>
              <div class="doc-meta">${metaRows}</div>
            </div>
          </div>
        </div>
        <table>
          <colgroup>
            <col style="width:12%;" />
            <col style="width:29%;" />
            <col style="width:7%;" />
            <col style="width:9%;" />
            <col style="width:14%;" />
            <col style="width:8%;" />
            <col style="width:9%;" />
            <col style="width:6%;" />
            <col style="width:10%;" />
            <col style="width:11%;" />
          </colgroup>
          <thead>
            <tr>
              <th># Item</th>
              <th>Description</th>
              <th>Origin</th>
              <th>Brand</th>
              <th>Order Nr</th>
              <th>Weight</th>
              <th>GTIP</th>
              <th>Qty</th>
              <th>Price ${safeText(currency)}</th>
              <th>Amount ${safeText(currency)}</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="totals">
          <div class="totals-note">
            ${input.notes ? `<strong>Notes</strong><br/>${safeMultiline(input.notes)}<br/><br/>` : ""}
            Total ${totalQty.toLocaleString("en-US")} Items${typeof totalWeight === "number" ? ` | Net Weight ${totalWeight.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Kg` : ""}
          </div>
          <div class="totals-card">${totalsRows}</div>
        </div>
        <div class="footer">
          <div class="footer-company-meta">${safeText(footerLine)}${input.company.bankDetails ? `<br />${safeMultiline(input.company.bankDetails)}` : ""}</div>
        </div>
        <div class="signature-grid">
          <div class="signature-box">Authorized Signature</div>
          <div class="signature-box">Receiver Signature</div>
        </div>
        <div class="page-counter" data-total-pages="1"></div>
        <script>
          (function () {
            var counter = document.querySelector('.page-counter');
            if (!counter) return;
            var pxPerMm = 96 / 25.4;
            var printableHeight = (297 - 14 - 18) * pxPerMm;
            var totalPages = Math.max(1, Math.ceil(document.body.scrollHeight / printableHeight));
            counter.setAttribute('data-total-pages', String(totalPages));
          })();
        </script>
      </div>
    </body>
  </html>`;
}
