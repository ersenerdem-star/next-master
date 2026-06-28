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
import { useI18n } from "../../i18n/I18nProvider";

type TranslateFn = (path: string, params?: Record<string, string | number>) => string;

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

async function parseCPriceImportFile(file: File, t: TranslateFn) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  let parsedRows: string[][] = [];

  if (isSpreadsheetTextExtension(extension)) {
    assertSpreadsheetFile(file, ["csv", "tsv", "txt", "xlsx", "xlsm", "xls"]);
    parsedRows = parseCsv(await file.text());
  } else if (["xlsx", "xlsm", "xls"].includes(extension)) {
    parsedRows = await readSpreadsheetMatrix(file);
  } else {
    throw new Error(t("sales.priceLists.uploadSpreadsheetFiles"));
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
  const { t } = useI18n();
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"success" | "error" | null>(null);
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
          setStatus(caught instanceof Error ? caught.message : t("sales.priceLists.loadFailed"));
          setStatusTone("error");
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  const cBrandOptions = [
    { value: "", label: t("sales.priceLists.selectBrand") },
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: t("sales.priceLists.newBrand") },
  ];

  const cImportModeOptions = [
    { value: "replace", label: t("sales.priceLists.replaceCList") },
    { value: "merge", label: t("sales.priceLists.mergeCList") },
  ];
  const downloadListOptions = [
    { value: "A", label: t("sales.priceLists.aPriceList") },
    { value: "B", label: t("sales.priceLists.bPriceList") },
    { value: "C", label: t("sales.priceLists.cPriceList") },
  ];
  const downloadBrandOptions = [
    { value: "", label: brands.length ? t("sales.priceLists.selectBrand") : t("sales.priceLists.noBrandsAvailable") },
    ...brands.map((item) => ({ value: item.name, label: item.name })),
  ];

  async function handleSaveMargins() {
    const nextA = Number(marginA);
    const nextB = Number(marginB);
    if (!Number.isFinite(nextA) || !Number.isFinite(nextB)) {
      setStatus(t("sales.priceLists.marginsMustBeNumeric"));
      setStatusTone("error");
      return;
    }

    try {
      setStatus("");
      setStatusTone(null);
      setSavingMargins(true);
      actionFeedback.begin(t("sales.priceLists.savingMargins"));
      await Promise.all([updateMarginPriceList("A", nextA), updateMarginPriceList("B", nextB)]);
      setStatus(t("sales.priceLists.marginsUpdated"));
      setStatusTone("success");
      actionFeedback.succeed(t("sales.priceLists.marginsUpdated"));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("sales.priceLists.marginUpdateFailed");
      setStatus(message);
      setStatusTone("error");
      actionFeedback.fail(message);
    } finally {
      setSavingMargins(false);
    }
  }

  async function handleImportCPriceList() {
    const activeBrand = cImportBrand === "__new__" ? cImportBrandName.trim() : cImportBrand;
    if (!activeBrand || !cImportFile) {
      setStatus(t("sales.priceLists.brandAndFileRequired"));
      setStatusTone("error");
      return;
    }

    try {
      setStatus("");
      setStatusTone(null);
      setImportingC(true);
      actionFeedback.begin(t("sales.priceLists.importingForBrand", { brandName: activeBrand }));
      const rows = await parseCPriceImportFile(cImportFile, t);
      if (!rows.length) {
        throw new Error(t("sales.priceLists.noValidRows"));
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
      const duplicateNote = result.duplicateCount
        ? t("sales.priceLists.importDuplicateNote", { count: result.duplicateCount })
        : "";
      setStatus(t("sales.priceLists.importedStatus", { brandName: result.brandName, uniqueCount: result.uniqueCount, duplicateNote }).trim());
      setStatusTone("success");
      actionFeedback.succeed(t("sales.priceLists.importedForBrand", { brandName: result.brandName }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("sales.priceLists.cImportFailed");
      setStatus(message);
      setStatusTone("error");
      actionFeedback.fail(message);
    } finally {
      setImportingC(false);
    }
  }

  async function handleDownloadPriceList() {
    if (!downloadBrand) {
      setStatus(t("sales.priceLists.selectBrandBeforeDownload"));
      setStatusTone("error");
      return;
    }

    try {
      setStatus("");
      setStatusTone(null);
      setDownloadingPriceList(true);
      actionFeedback.begin(t("sales.priceLists.preparingDownload", { listType: downloadListType, brandName: downloadBrand }));
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
          ? t("sales.priceLists.downloadedOldCodesSkipped", { listType: downloadListType, brandName: downloadBrand })
          : t("sales.priceLists.downloaded", { listType: downloadListType, brandName: downloadBrand }),
      );
      setStatusTone("success");
      actionFeedback.succeed(t("sales.priceLists.downloaded", { listType: downloadListType, brandName: downloadBrand }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t("sales.priceLists.downloadFailed");
      setStatus(message);
      setStatusTone("error");
      actionFeedback.fail(message);
    } finally {
      setDownloadingPriceList(false);
    }
  }

  return (
    <SectionCard title={t("sales.priceLists.title")}>
      <div className="settings-grid">
        <div className="settings-item">
          <span className="settings-label">{t("sales.priceLists.aMarginLabel")}</span>
          <Input value={marginA} placeholder={t("sales.priceLists.marginPlaceholder")} onChange={setMarginA} />
        </div>
        <div className="settings-item">
          <span className="settings-label">{t("sales.priceLists.bMarginLabel")}</span>
          <Input value={marginB} placeholder={t("sales.priceLists.marginPlaceholder")} onChange={setMarginB} />
        </div>
      </div>
      <div className="toolbar toolbar--wrap">
        <Button onClick={() => void handleSaveMargins()} busy={savingMargins} busyLabel={t("common.saving")}>
          {t("sales.priceLists.saveMargins")}
        </Button>
        <Button variant="secondary" onClick={() => setShowCImportDialog(true)}>
          {t("sales.priceLists.uploadCPriceList")}
        </Button>
      </div>
      <div className="settings-grid">
        <div className="settings-item">
          <span className="settings-label">{t("sales.priceLists.downloadBrand")}</span>
          <Select value={downloadBrand} options={downloadBrandOptions} onChange={setDownloadBrand} />
        </div>
        <div className="settings-item">
          <span className="settings-label">{t("sales.priceLists.priceListType")}</span>
          <Select value={downloadListType} options={downloadListOptions} onChange={(value) => setDownloadListType(value as "A" | "B" | "C")} />
        </div>
      </div>
      <div className="toolbar toolbar--wrap">
        <Button variant="secondary" onClick={() => void handleDownloadPriceList()} disabled={!downloadBrand} busy={downloadingPriceList} busyLabel={t("sales.priceLists.preparing")}>
          {t("sales.priceLists.downloadPriceList")}
        </Button>
      </div>
      {status ? <div className={statusTone === "success" ? "success-text" : "error-text"}>{status}</div> : null}

      {showCImportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>{t("sales.priceLists.modalTitle")}</h3>
                <p>{t("sales.priceLists.modalDescription")}</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label={t("sales.priceLists.brand")}
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
                label={t("sales.priceLists.brandName")}
                value={cImportBrandName}
                placeholder={t("sales.priceLists.brandNamePlaceholder")}
                onChange={setCImportBrandName}
                disabled={cImportBrand !== "__new__"}
              />
              <Select label={t("sales.priceLists.importMode")} value={cImportMode} options={cImportModeOptions} onChange={setCImportMode} />
              <Input label={t("sales.priceLists.target")} value={t("sales.priceLists.targetCustomerCManual")} onChange={() => undefined} disabled />
              <label className="field">
                <span className="field__label">{t("sales.priceLists.file")}</span>
                <input
                  className="field__input"
                  type="file"
                  accept=".csv,text/csv,.tsv,.txt,.xlsx,.xls,.xlsm"
                  onChange={(event) => setCImportFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <Input label={t("sales.priceLists.selectedFile")} value={cImportFile?.name ?? ""} placeholder={t("sales.priceLists.noFileSelected")} onChange={() => undefined} disabled />
            </div>
            <div className="modal-hint">{t("sales.priceLists.modalHint")}</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadCPriceListTemplate();
                  actionFeedback.succeed(t("sales.priceLists.sampleTemplateDownloaded"));
                }}
              >
                {t("sales.priceLists.downloadSampleTemplate")}
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
                {t("sales.priceLists.cancelImport")}
              </Button>
              <Button
                onClick={() => void handleImportCPriceList()}
                disabled={!cImportBrand || !(cImportBrand === "__new__" ? cImportBrandName.trim() : true) || !cImportMode || !cImportFile}
                busy={importingC}
                busyLabel={t("sales.priceLists.importing")}
              >
                {t("sales.priceLists.import")}
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}
    </SectionCard>
  );
}
