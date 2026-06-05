import { useEffect, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCatalogExportRows } from "../../infrastructure/api/catalogApi";
import { fetchCPriceMapForRows, getCPriceForRow } from "../../infrastructure/api/cPriceApi";
import { fetchBrandMarginPriceSummaries, fetchPriceListSettings, importCPriceList, updateMarginPriceList } from "../../infrastructure/api/priceListsApi";
import { fetchOldCodesByNewCodeForBrand } from "../../infrastructure/api/codeReferencesApi";
import { parseCsv, normalizeText } from "../../shared/csv";
import { normalizePartCode } from "../../domain/shared/normalize";
import type { BrandOption } from "../../types/brand";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DraggableSurface } from "../components/common/DraggableSurface";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";
import { downloadCPriceListTemplate } from "../../shared/importTemplates";
import { assertSpreadsheetFile, isSpreadsheetTextExtension, readSpreadsheetMatrix } from "../../shared/spreadsheetImport";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";

function normalizeImportHeader(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function normalizeLoosePrice(value: string | null | undefined) {
  const text = String(value || "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!text) return null;

  const match = text.match(/-?\d[\d\s.,]*/);
  if (!match) return null;
  const numeric = match[0].replace(/\s+/g, "").replace(",", ".");
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOldCodeCoverageTimeoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("old code coverage load timed out") ||
    normalized.includes("statement timeout") ||
    normalized.includes("canceling statement due to statement timeout") ||
    normalized.includes("the request took too long")
  );
}

async function parseCPriceImportFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  let parsedRows: string[][] = [];

  if (isSpreadsheetTextExtension(extension)) {
    assertSpreadsheetFile(file, ["csv", "tsv", "txt", "xlsx", "xlsm", "xls"]);
    parsedRows = parseCsv(await file.text());
  } else if (["xlsx", "xlsm", "xls"].includes(extension)) {
    parsedRows = await readSpreadsheetMatrix(file);
  } else {
    throw new Error("Upload CSV, TSV, TXT, XLSX or XLS files.");
  }

  const [header = [], ...dataRows] = parsedRows;
  const normalizedHeader = header.map((cell) => normalizeImportHeader(cell));
  const findIndex = (aliases: string[], fallback: number) => {
    const found = normalizedHeader.findIndex((cell) => aliases.includes(cell));
    return found >= 0 ? found : fallback;
  };

  const codeIndex = findIndex(
    ["product_code", "part", "code", "part_no", "part_number", "part_code", "new_code"],
    0,
  );
  const priceIndex = findIndex(
    [
      "c_sales_eur",
      "c_sales_price",
      "customer_c_price",
      "customer_c_sales",
      "customer_c",
      "special_c_price",
      "c_price",
      "c_sales",
      "sales_c",
      "price_c",
      "net_price",
      "sales_eur",
      "sales",
      "price",
      "sell_price",
      "sales_price_eur",
    ],
    1,
  );

  return dataRows
    .map((row) => ({
      product_code: normalizeText(row[codeIndex]) || "",
      sell_price: normalizeLoosePrice(row[priceIndex]) ?? NaN,
    }))
    .filter((row) => row.product_code && Number.isFinite(row.sell_price));
}

export function PriceListsPage() {
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [status, setStatus] = useState("");
  const [marginA, setMarginA] = useState("10");
  const [marginB, setMarginB] = useState("15");
  const [showCImportDialog, setShowCImportDialog] = useState(false);
  const [cImportBrand, setCImportBrand] = useState("");
  const [cImportBrandName, setCImportBrandName] = useState("");
  const [cImportMode, setCImportMode] = useState("replace");
  const [cImportFile, setCImportFile] = useState<File | null>(null);
  const [savingMargins, setSavingMargins] = useState(false);
  const [importingC, setImportingC] = useState(false);
  const [downloadBrand, setDownloadBrand] = useState("");
  const [downloadListType, setDownloadListType] = useState<"A" | "B" | "C">("A");
  const [downloadingPriceList, setDownloadingPriceList] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [settings, brandRows] = await Promise.all([fetchPriceListSettings(), fetchCloudBrands()]);
        if (cancelled) return;
        const a = settings.find((item) => item.listType === "A");
        const b = settings.find((item) => item.listType === "B");
        setMarginA(typeof a?.marginPercent === "number" ? String(a.marginPercent) : "10");
        setMarginB(typeof b?.marginPercent === "number" ? String(b.marginPercent) : "15");
        setBrands(brandRows);
      } catch (caught) {
        if (!cancelled) {
          setBrands([]);
          setStatus(caught instanceof Error ? caught.message : "Price list settings load failed");
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const cBrandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: "New brand..." },
  ];

  const cImportModeOptions = [
    { value: "replace", label: "Replace selected brand in C list" },
    { value: "merge", label: "Merge into selected brand in C list" },
  ];
  const downloadListOptions = [
    { value: "A", label: "A Price List" },
    { value: "B", label: "B Price List" },
    { value: "C", label: "C Price List" },
  ];

  async function handleSaveMargins() {
    const nextA = Number(marginA);
    const nextB = Number(marginB);
    if (!Number.isFinite(nextA) || !Number.isFinite(nextB)) {
      setStatus("A and B margins must be numeric.");
      return;
    }

    try {
      setStatus("");
      setSavingMargins(true);
      actionFeedback.begin("Saving A and B margin settings...");
      await Promise.all([updateMarginPriceList("A", nextA), updateMarginPriceList("B", nextB)]);
      setStatus("A and B margins updated.");
      actionFeedback.succeed("A and B margins updated.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Margin update failed";
      setStatus(message);
      actionFeedback.fail(message);
    } finally {
      setSavingMargins(false);
    }
  }

  async function handleImportCPriceList() {
    const activeBrand = cImportBrand === "__new__" ? cImportBrandName.trim() : cImportBrand;
    if (!activeBrand || !cImportFile) {
      setStatus("Brand and file are required for C price import.");
      return;
    }

    try {
      setStatus("");
      setImportingC(true);
      actionFeedback.begin(`Importing C price list for ${activeBrand}...`);
      const rows = await parseCPriceImportFile(cImportFile);
      if (!rows.length) {
        throw new Error("No valid C price rows found in file.");
      }
      const result = await importCPriceList({
        brandName: activeBrand,
        mode: cImportMode as "replace" | "merge",
        rows,
      });

      const refreshedBrands = await fetchCloudBrands();
      setBrands(refreshedBrands);
      const matchedBrand = refreshedBrands.find((item) => item.name.trim().toLowerCase() === activeBrand.trim().toLowerCase());
      if (matchedBrand) {
        setCImportBrand(matchedBrand.name);
        setCImportBrandName(matchedBrand.name);
      }
      setCImportFile(null);
      setShowCImportDialog(false);
      const duplicateNote = result.duplicateCount ? ` ${result.duplicateCount} duplicate code row collapsed.` : "";
      setStatus(`C price list imported for ${result.brandName}. ${result.uniqueCount} unique rows loaded.${duplicateNote}`);
      actionFeedback.succeed(`C price list imported for ${result.brandName}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "C price import failed";
      setStatus(message);
      actionFeedback.fail(message);
    } finally {
      setImportingC(false);
    }
  }

  async function handleDownloadPriceList() {
    if (!downloadBrand) {
      setStatus("Select a brand before downloading a price list.");
      return;
    }

    try {
      setStatus("");
      setDownloadingPriceList(true);
      actionFeedback.begin(`Preparing ${downloadListType} price list for ${downloadBrand}...`);
      const sheetRows: Array<Array<string | number | null>> = [["New_Code", "Old_Codes", "Brand", "Product_Name", "OEM_No", "HS_Code", "Origin", "Weight_kg", "Price_List_Type", "Sales_Price_EUR", "Notes"]];
      let oldCodeCoverageTimedOut = false;

      if (downloadListType === "C") {
        const catalogRows = await fetchCatalogExportRows({ brandName: downloadBrand });
        const cPriceMap = await fetchCPriceMapForRows(
          catalogRows.map((row) => ({
            brand: row.brand,
            product_code: row.product_code,
          })),
        );
        const oldCodesByNewCode: Record<string, string[]> = await fetchOldCodesByNewCodeForBrand({
          brand: downloadBrand,
          newCodes: catalogRows.map((row) => row.product_code),
        }).catch((caught) => {
          if (isOldCodeCoverageTimeoutError(caught)) {
            oldCodeCoverageTimedOut = true;
            return {} as Record<string, string[]>;
          }
          throw caught;
        });

        sheetRows.push(
          ...catalogRows.map((row) => [
            row.product_code,
            (oldCodesByNewCode[row.product_code.replace(/[^A-Za-z0-9]/g, "").toUpperCase()] || []).join(" | "),
            row.brand,
            row.description || "",
            row.oem_no || "",
            row.hs_code || "",
            row.origin || "",
            row.weight_kg ?? "",
            `${downloadListType} Price List`,
            getCPriceForRow(cPriceMap, { brand: row.brand, product_code: row.product_code }) ?? "",
            "",
          ]),
        );
      } else {
        const catalogRows = await fetchCatalogExportRows({ brandName: downloadBrand });
        const marginPercent = downloadListType === "A" ? Number(marginA) / 100 : Number(marginB) / 100;
        const salesPriceMap = await fetchBrandMarginPriceSummaries({
          brandName: downloadBrand,
          rows: catalogRows,
          marginPercent,
        });
        const oldCodesByNewCode: Record<string, string[]> = await fetchOldCodesByNewCodeForBrand({
          brand: downloadBrand,
          newCodes: catalogRows.map((row) => row.product_code),
        }).catch((caught) => {
          if (isOldCodeCoverageTimeoutError(caught)) {
            oldCodeCoverageTimedOut = true;
            return {} as Record<string, string[]>;
          }
          throw caught;
        });

        sheetRows.push(
          ...catalogRows.map((row) => {
            const normalizedCode = normalizePartCode(row.product_code);
            const priceSummary = salesPriceMap.get(normalizedCode);
            return [
              row.product_code,
              (oldCodesByNewCode[normalizedCode] || []).join(" | "),
              row.brand,
              row.description || "",
              row.oem_no || "",
              row.hs_code || "",
              row.origin || "",
              row.weight_kg ?? "",
              `${downloadListType} Price List`,
              priceSummary?.salesPrice ?? "",
              priceSummary?.notes || "",
            ];
          }),
        );
      }

      const blob = buildXlsxBlob(`${downloadBrand} ${downloadListType}`, sheetRows, [8, 10, 13]);
      downloadBlob(`price-list-${downloadBrand.toLowerCase().replace(/\s+/g, "-")}-${downloadListType.toLowerCase()}.xlsx`, blob);
      setStatus(
        oldCodeCoverageTimedOut
          ? `${downloadListType} price list downloaded for ${downloadBrand}. Old code column was skipped because coverage lookup took too long.`
          : `${downloadListType} price list downloaded for ${downloadBrand}.`,
      );
      actionFeedback.succeed(`${downloadListType} price list downloaded for ${downloadBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Price list download failed";
      setStatus(message);
      actionFeedback.fail(message);
    } finally {
      setDownloadingPriceList(false);
    }
  }

  return (
    <SectionCard title="Price Lists">
      <div className="settings-grid">
        <div className="settings-item">
          <span className="settings-label">A Margin %</span>
          <Input value={marginA} onChange={setMarginA} />
        </div>
        <div className="settings-item">
          <span className="settings-label">B Margin %</span>
          <Input value={marginB} onChange={setMarginB} />
        </div>
      </div>
      <div className="toolbar toolbar--wrap">
        <Button onClick={() => void handleSaveMargins()} busy={savingMargins} busyLabel="Saving...">
          Save A/B Margins
        </Button>
        <Button variant="secondary" onClick={() => setShowCImportDialog(true)}>
          Upload C Price List
        </Button>
      </div>
      <div className="settings-grid">
        <div className="settings-item">
          <span className="settings-label">Download Brand</span>
          <Select value={downloadBrand} options={brands.map((item) => ({ value: item.name, label: item.name }))} onChange={setDownloadBrand} />
        </div>
        <div className="settings-item">
          <span className="settings-label">Price List Type</span>
          <Select value={downloadListType} options={downloadListOptions} onChange={(value) => setDownloadListType(value as "A" | "B" | "C")} />
        </div>
      </div>
      <div className="toolbar toolbar--wrap">
        <Button variant="secondary" onClick={() => void handleDownloadPriceList()} disabled={!downloadBrand} busy={downloadingPriceList} busyLabel="Preparing...">
          Download Price List
        </Button>
      </div>
      {status ? <div className={status.includes("updated") || status.includes("imported") ? "success-text" : "error-text"}>{status}</div> : null}

      {showCImportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>C Price List Import</h3>
                <p>Manual special prices. These values override formula-based pricing for customer C.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Brand"
                value={cImportBrand}
                options={cBrandOptions}
                onChange={(value) => {
                  setCImportBrand(value);
                  if (value !== "__new__") {
                    setCImportBrandName(value);
                  } else {
                    setCImportBrandName("");
                  }
                }}
              />
              <Input
                label="Brand Name"
                value={cImportBrandName}
                onChange={setCImportBrandName}
                disabled={cImportBrand !== "__new__"}
              />
              <Select label="Import Mode" value={cImportMode} options={cImportModeOptions} onChange={setCImportMode} />
              <Input label="Target" value="Customer C manual price list" onChange={() => undefined} disabled />
              <label className="field">
                <span className="field__label">File</span>
                <input
                  className="field__input"
                  type="file"
                  accept=".csv,text/csv,.tsv,.txt,.xlsx,.xls,.xlsm"
                  onChange={(event) => setCImportFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <Input label="Selected file" value={cImportFile?.name ?? ""} onChange={() => undefined} disabled />
            </div>
            <div className="modal-hint">Brand, import mode, target, and file are required. C list is fully manual and not formula-based.</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadCPriceListTemplate();
                  actionFeedback.succeed("C price list sample template downloaded.");
                }}
              >
                Download Sample Template
              </Button>
            </div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowCImportDialog(false);
                  setCImportFile(null);
                }}
              >
                Cancel Import
              </Button>
              <Button
                onClick={() => void handleImportCPriceList()}
                disabled={!cImportBrand || !(cImportBrand === "__new__" ? cImportBrandName.trim() : true) || !cImportMode || !cImportFile}
                busy={importingC}
                busyLabel="Importing..."
              >
                Import
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}
    </SectionCard>
  );
}
