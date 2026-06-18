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
  oldCode?: string;
  description: string;
  origin?: string;
  brand?: string;
  orderNo?: string;
  weight?: string;
  gtip?: string;
  alerts?: Array<{
    text: string;
    tone?: "warning" | "danger" | "muted";
  }>;
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
  showOrderNoColumn?: boolean;
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
  const showOrderNoColumn = input.showOrderNoColumn ?? true;
  const compactLayout = !showOrderNoColumn;
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
      (line, index) => {
        const alertsHtml = (line.alerts || [])
          .filter((alert) => String(alert?.text || "").trim())
          .map(
            (alert) =>
              `<div class="line-alert line-alert--${safeText(alert.tone || "warning")}">${safeText(alert.text)}</div>`,
          )
          .join("");
        const oldCodeHtml = !compactLayout && line.oldCode ? `<div class="line-subtext">Old code: ${safeText(line.oldCode)}</div>` : "";
        if (compactLayout) {
          return `
        <tr>
          <td class="line-index">${safeText(index + 1)}</td>
          <td><span class="line-item">${safeText([line.code, line.description].filter(Boolean).join(" ").trim())}</span>${alertsHtml ? `<div class="line-alerts">${alertsHtml}</div>` : ""}</td>
          <td>${safeText(line.weight || "")}</td>
          <td>${safeText(line.origin || "")}</td>
          <td>${safeText(line.brand || "")}</td>
          <td>${safeText(line.gtip || "")}</td>
          <td>${safeText(line.qty)}</td>
          <td>${formatMoney(line.unitPrice, currency)}</td>
          <td>${formatMoney(line.amount, currency)}</td>
        </tr>
      `;
        }
        return `
        <tr>
          <td><div class="line-code-wrap"><span class="line-code">${safeText(line.code)}</span>${oldCodeHtml}</div></td>
          <td><span class="line-description">${safeText(line.description)}</span>${alertsHtml ? `<div class="line-alerts">${alertsHtml}</div>` : ""}</td>
          <td>${safeText(line.origin || "")}</td>
          <td>${safeText(line.brand || "")}</td>
          ${showOrderNoColumn ? `<td><span class="line-order-no">${safeText(line.orderNo || "")}</span></td>` : ""}
          <td>${safeText(line.weight || "")}</td>
          <td>${safeText(line.gtip || "")}</td>
          <td>${safeText(line.qty)}</td>
          <td>${formatMoney(line.unitPrice, currency)}</td>
          <td>${formatMoney(line.amount, currency)}</td>
        </tr>
      `;
      },
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

  const tableClass = compactLayout
    ? "business-document-table business-document-table--compact"
    : showOrderNoColumn
      ? "business-document-table business-document-table--with-order-no"
      : "business-document-table business-document-table--without-order-no";
  const colgroupHtml = showOrderNoColumn
    ? `
          <col style="width:14%;" />
          <col style="width:27%;" />
          <col style="width:7%;" />
          <col style="width:9%;" />
          <col style="width:13%;" />
          <col style="width:8%;" />
          <col style="width:9%;" />
          <col style="width:6%;" />
          <col style="width:10%;" />
          <col style="width:11%;" />
        `
    : `
          <col style="width:14%;" />
          <col style="width:31%;" />
          <col style="width:8%;" />
          <col style="width:10%;" />
          <col style="width:9%;" />
          <col style="width:10%;" />
          <col style="width:8%;" />
          <col style="width:10%;" />
          <col style="width:12%;" />
        `;
  const compactColgroupHtml = `
          <col style="width:5%;" />
          <col style="width:27%;" />
          <col style="width:9%;" />
          <col style="width:10%;" />
          <col style="width:14%;" />
          <col style="width:13%;" />
          <col style="width:7%;" />
          <col style="width:8%;" />
          <col style="width:7%;" />
        `;
  const compactMetaRows = input.meta
    .map(
      (item) => `
        <div class="doc-meta-row doc-meta-row--compact">
          <div class="doc-meta-label">${safeText(item.label)} :</div>
          <div class="doc-meta-value">${safeText(item.value || "-")}</div>
        </div>
      `,
    )
    .join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>${safeText(input.docNo || input.docType)}</title>
      <style>
        @page { margin: 14mm 12mm 18mm; }
        html { background:#fff; }
        body { font-family: "Helvetica Neue", Arial, sans-serif; color: #111827; margin: 0; font-size: 8.6pt; background:#fff; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
        .page { padding: 0; background:#fff; }
        .header-shell { display:grid; grid-template-columns:minmax(0, 1fr) 84mm; align-items:stretch; gap:12mm; margin-bottom:5mm; width:100%; }
        .header-left { display:grid; grid-template-columns:58mm minmax(0, 1fr); gap:4mm 7mm; align-items:start; width:100%; min-width:0; }
        .header-right { display:flex; justify-content:flex-end; align-items:stretch; justify-self:end; width:84mm; min-width:84mm; }
        .header-card { border:0.25mm solid #d7dee8; border-radius:5px; padding:3mm 3.5mm; background:#fff; box-sizing:border-box; }
        .seller-card { width:100%; min-width:0; grid-column:1; }
        .party-card { width:100%; max-width:none; min-width:0; grid-column:2; }
        .meta-card { width:84mm; min-width:84mm; max-width:84mm; min-height:100%; height:100%; margin-left:auto; display:flex; flex-direction:column; }
        .identity-row { display:flex; flex-direction:column; align-items:center; gap:1.5mm; width:100%; }
        .header-logo { width:100%; min-height:14mm; display:flex; justify-content:center; align-items:flex-start; }
        .seller-name { width:100%; text-align:center; font-size:7.1pt; font-weight:700; line-height:1.22; letter-spacing:0.01em; }
        .billto-title { font-size:6.9pt; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#6b7280; margin:0 0 1.5mm; }
        .billto-grid { display:grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); gap:6mm; width:100%; align-items:start; }
        .billto-box { font-size:7.5pt; line-height:1.4; white-space:pre-wrap; }
        .doc-top { display:flex; justify-content:flex-end; margin-bottom:4mm; }
        .doc-heading { text-align:right; width:100%; }
        .doc-eyebrow { font-size:6.8pt; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#6b7280; margin-bottom:1mm; }
        .doc-title { font-size:11pt; font-weight:700; line-height:1.1; margin:0; letter-spacing:-0.01em; word-break:break-word; }
        .doc-number { margin-top:1mm; font-size:7.9pt; font-weight:700; color:#4b5563; line-height:1.2; }
        .doc-meta { display:flex; flex-direction:column; gap:2mm; width:100%; }
        .doc-meta-row { display:flex; flex-direction:column; gap:0.6mm; align-items:flex-start; }
        .doc-meta-row--compact { flex-direction:row; align-items:baseline; gap:2.5mm; justify-content:space-between; }
        .doc-meta-label { font-size:6.9pt; font-weight:700; letter-spacing:0.03em; text-transform:uppercase; color:#475569; white-space:nowrap; }
        .doc-meta-value { font-size:7.4pt; font-weight:500; color:#111827; word-break:break-word; line-height:1.25; }
        .business-document-table { width:100%; border-collapse:collapse; margin-top:4mm; page-break-inside:auto; table-layout:fixed; }
        thead { display:table-header-group; }
        tfoot { display:table-footer-group; }
        tbody { page-break-inside:auto; }
        tr { page-break-inside:avoid; break-inside:avoid-page; page-break-after:auto; }
        th, td { border:0.25mm solid #d7dee8; padding:1.5mm 1.7mm; text-align:left; vertical-align:top; font-size:7.2pt; word-break:normal; overflow-wrap:break-word; }
        th { background:#f4f7fa; font-weight:700; line-height:1.18; }
        .business-document-table--with-order-no th:nth-child(1), .business-document-table--with-order-no td:nth-child(1),
        .business-document-table--with-order-no th:nth-child(5), .business-document-table--with-order-no td:nth-child(5) { white-space:nowrap; }
        .business-document-table--with-order-no td:nth-child(8), .business-document-table--with-order-no td:nth-child(9), .business-document-table--with-order-no td:nth-child(10),
        .business-document-table--with-order-no th:nth-child(8), .business-document-table--with-order-no th:nth-child(9), .business-document-table--with-order-no th:nth-child(10) { text-align:right; }
        .business-document-table--without-order-no th:nth-child(1), .business-document-table--without-order-no td:nth-child(1),
        .business-document-table--without-order-no th:nth-child(5), .business-document-table--without-order-no td:nth-child(5) { white-space:nowrap; }
        .business-document-table--without-order-no td:nth-child(7), .business-document-table--without-order-no td:nth-child(8), .business-document-table--without-order-no td:nth-child(9),
        .business-document-table--without-order-no th:nth-child(7), .business-document-table--without-order-no th:nth-child(8), .business-document-table--without-order-no th:nth-child(9) { text-align:right; }
        .business-document-table--compact { margin-top:6mm; }
        .business-document-table--compact th, .business-document-table--compact td { font-size:7.9pt; padding:2mm 2mm; }
        .business-document-table--compact th { background:#404040; color:#f7f7f7; font-weight:500; }
        .business-document-table--compact td:nth-child(1), .business-document-table--compact th:nth-child(1) { text-align:center; white-space:nowrap; }
        .business-document-table--compact td:nth-child(7), .business-document-table--compact td:nth-child(8), .business-document-table--compact td:nth-child(9),
        .business-document-table--compact th:nth-child(7), .business-document-table--compact th:nth-child(8), .business-document-table--compact th:nth-child(9) { text-align:center; }
        .business-document-table--compact td:nth-child(3), .business-document-table--compact td:nth-child(8), .business-document-table--compact td:nth-child(9) { white-space:nowrap; }
        .business-document-table--compact .line-item { white-space:normal; word-break:normal; overflow-wrap:break-word; }
        .business-document-table--compact .line-alerts { margin-top:0.5mm; }
        .line-code-wrap { display:flex; flex-direction:column; gap:0.6mm; }
        .line-code, .line-order-no { white-space:nowrap; word-break:keep-all; overflow-wrap:normal; }
        .line-description { white-space:normal; word-break:normal; overflow-wrap:break-word; }
        .line-subtext { font-size:6.3pt; color:#64748b; line-height:1.18; white-space:normal; word-break:break-word; overflow-wrap:anywhere; }
        .line-alerts { display:flex; flex-direction:column; gap:0.5mm; margin-top:0.8mm; }
        .line-alert { font-size:6.4pt; font-weight:700; line-height:1.22; }
        .line-alert--warning { color:#b45309; }
        .line-alert--danger { color:#b91c1c; }
        .line-alert--muted { color:#475569; font-weight:600; }
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
        .page--compact .header-shell { grid-template-columns: minmax(0, 1fr) 82mm; gap:10mm; }
        .page--compact .header-left { display:flex; flex-direction:column; gap:6mm; }
        .page--compact .header-card { border:0; padding:0; border-radius:0; }
        .page--compact .seller-card { width:auto; }
        .page--compact .party-card { width:auto; }
        .page--compact .meta-card { width:82mm; min-width:82mm; max-width:82mm; padding-top:1mm; }
        .page--compact .identity-row { align-items:flex-start; gap:2mm; }
        .page--compact .header-logo { justify-content:flex-start; min-height:22mm; }
        .page--compact .seller-name { text-align:left; font-size:8.1pt; line-height:1.28; }
        .page--compact .billto-title { font-size:7.3pt; color:#3f3f3f; letter-spacing:0; text-transform:none; margin-bottom:1mm; }
        .page--compact .billto-box { font-size:8.1pt; line-height:1.32; }
        .page--compact .doc-top { margin-bottom:1mm; }
        .page--compact .doc-title { font-size:22pt; font-weight:500; line-height:1; }
        .page--compact .doc-eyebrow { display:none; }
        .page--compact .doc-number { margin-top:1.5mm; font-size:8.6pt; font-weight:700; color:#404040; }
        .page--compact .doc-meta { gap:2.5mm; margin-top:1.5mm; }
        .page--compact .doc-meta-label { font-size:7.2pt; font-weight:400; color:#404040; text-transform:none; letter-spacing:0; white-space:normal; }
        .page--compact .doc-meta-value { font-size:7.2pt; font-weight:400; color:#404040; text-align:right; }
        .page--compact .totals { display:none; }
        .page--compact .footer { margin-top:4mm; font-size:7.1pt; color:#374151; }
        .page--compact .signature-grid { display:none; }
        @media screen {
          body { margin: 24px 28px 46px; }
          .page-counter::before { content:"Page 1 / " attr(data-total-pages); }
        }
      </style>
    </head>
    <body>
      <div class="page${compactLayout ? " page--compact" : ""}">
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
                  ${compactLayout
                    ? `<div class="doc-title">${safeText(input.docType)}</div><div class="doc-number"># ${safeText(input.docNo)}</div>`
                    : `<div class="doc-eyebrow">${safeText(input.docType)}</div><div class="doc-title"># ${safeText(input.docNo)}</div>`}
                </div>
              </div>
              <div class="doc-meta">${compactLayout ? compactMetaRows : metaRows}</div>
            </div>
          </div>
        </div>
        <table class="${tableClass}">
          <colgroup>
            ${compactLayout ? compactColgroupHtml : colgroupHtml}
          </colgroup>
          <thead>
            <tr>
              ${compactLayout ? "<th>#</th><th>Item &amp; Description</th><th>Weight</th><th>Origin</th><th>Brand</th><th>Tariff</th><th>Qty</th><th>Price " + safeText(currency) + "</th><th>Amount " + safeText(currency) + "</th>" : "<th># Item</th><th>Description</th><th>Origin</th><th>Brand</th>" + (showOrderNoColumn ? "<th>Order Nr</th>" : "") + "<th>Weight</th><th>Tariff</th><th>Qty</th><th>Price " + safeText(currency) + "</th><th>Amount " + safeText(currency) + "</th>"}
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

function attachAutoPrintScript(html: string) {
  const script = `<script>
    window.addEventListener("load", function () {
      window.setTimeout(function () {
        window.print();
      }, 120);
    });
  </script>`;
  return html.includes("</body>") ? html.replace("</body>", `${script}</body>`) : `${html}${script}`;
}

export function openBusinessDocumentPreview(html: string, options?: { autoPrint?: boolean }) {
  const finalHtml = options?.autoPrint ? attachAutoPrintScript(html) : html;
  const blob = new Blob([finalHtml], { type: "text/html;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const previewWindow = window.open(objectUrl, "_blank", "noopener,noreferrer");
  if (!previewWindow) {
    URL.revokeObjectURL(objectUrl);
    throw new Error("Popup blocked while opening PDF view.");
  }
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  previewWindow.focus();
  return previewWindow;
}
