import { useEffect, useMemo, useState } from "react";
import { normalizePartCode } from "../../domain/shared/normalize";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCloudCatalog } from "../../infrastructure/api/catalogApi";
import { bulkImportSupplierPrices } from "../../infrastructure/api/importApi";
import {
  fetchCloudSupplierPrices,
  fetchCloudSupplierPricesAcrossSuppliers,
  fetchCloudSuppliers,
} from "../../infrastructure/api/suppliersApi";
import type { BrandOption } from "../../types/brand";
import type { CatalogRow } from "../../types/catalog";
import type { SupplierPriceRow, SupplierSummary } from "../../types/suppliers";
import { Button } from "../components/common/Button";
import { DraggableSurface } from "../components/common/DraggableSurface";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { BrandPill } from "../components/common/BrandPill";
import { downloadCsv, normalizeNumber, normalizeText, parseCsv, toCsv } from "../../shared/csv";
import { formatBrandAwareProductCode } from "../../shared/productCodeDisplay";
import { downloadSupplierTemplate } from "../../shared/importTemplates";
import { useI18n } from "../../i18n/I18nProvider";

const freshnessValues = ["all", "fresh", "aging", "stale", "unknown"] as const;

const SUPPLIER_IMPORT_COLUMNS = [
  "Product_Code",
  "Brand",
  "Product_Name",
  "OEM_No",
  "Buy_Price_EUR",
  "Price_Date",
  "MOQ",
  "Lead_Time_Days",
  "Notes",
] as const;

const SUPPLIER_IMPORT_HEADER_ALIASES: Record<(typeof SUPPLIER_IMPORT_COLUMNS)[number], string[]> = {
  Product_Code: ["Product_Code", "Product Code", "Part_No", "Part No", "PartNo", "Code"],
  Brand: ["Brand", "Brand_Name", "Brand Name"],
  Product_Name: ["Product_Name", "Product Name", "Description", "Name"],
  OEM_No: ["OEM_No", "OEM No", "OEM", "Original_Number", "Original Number"],
  Buy_Price_EUR: ["Buy_Price_EUR", "Buy Price EUR", "Buy_Price", "Buy Price", "Price_EUR", "Price"],
  Price_Date: ["Price_Date", "Price Date", "Valid_From", "Date"],
  MOQ: ["MOQ", "Min_Qty", "Minimum Order Quantity"],
  Lead_Time_Days: ["Lead_Time_Days", "Lead Time Days", "Lead_Time", "Lead Time"],
  Notes: ["Notes", "Note", "Comment", "Comments"],
};

const SUPPLIER_IMPORT_REQUIRED_COLUMNS = ["Product_Code", "Buy_Price_EUR"] as const;

export function SuppliersPage() {
  const { t } = useI18n();
  const p = (key: string, params?: Record<string, string | number>) => t(`purchases.${key}`, params);
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [importBrand, setImportBrand] = useState("");
  const [importBrandName, setImportBrandName] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showManualPriceDialog, setShowManualPriceDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importMode, setImportMode] = useState("replace");
  const [importSupplierId, setImportSupplierId] = useState("");
  const [importSupplierName, setImportSupplierName] = useState("");
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [freshness, setFreshness] = useState("all");
  const [rows, setRows] = useState<SupplierPriceRow[]>([]);
  const [loadingSuppliers, setLoadingSuppliers] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [warning, setWarning] = useState("");
  const [importingSupplier, setImportingSupplier] = useState(false);
  const [savingManualPrice, setSavingManualPrice] = useState(false);
  const [resolvingCatalogMatch, setResolvingCatalogMatch] = useState(false);
  const [searchingSuppliers, setSearchingSuppliers] = useState(false);
  const [exportingSuppliers, setExportingSuppliers] = useState(false);
  const [catalogMatch, setCatalogMatch] = useState<CatalogRow | null>(null);
  const [manualPriceDraft, setManualPriceDraft] = useState({
    supplier_id: "",
    brand: "",
    product_code: "",
    description: "",
    oem_no: "",
    buy_price: "",
    price_date: "",
    moq: "",
    lead_time_days: "",
    notes: "",
  });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const result = await fetchCloudBrands();
        if (!cancelled) setBrands(result);
      } catch {
        if (!cancelled) setBrands([]);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoadingSuppliers(true);
      setError("");
      try {
        const result = await fetchCloudSuppliers();
        if (cancelled) return;
        setSuppliers(result);
        const defaultSupplierId = result[0]?.supplier_id || "";
        setImportSupplierId((current) => current || defaultSupplierId);
        setImportSupplierName((current) => current || result[0]?.name || "");
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : p("suppliers.errors.requestFailed"));
        }
      } finally {
        if (!cancelled) setLoadingSuppliers(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!selectedSupplierId && !submittedSearch.trim()) {
        setRows([]);
        return;
      }

      setLoadingRows(true);
      setError("");
      try {
        const result = selectedSupplierId
          ? await fetchCloudSupplierPrices({
              supplierId: selectedSupplierId,
              search: submittedSearch,
              freshness,
              page: 1,
              pageSize: 50,
            })
          : await fetchCloudSupplierPricesAcrossSuppliers({
              suppliers,
              search: submittedSearch,
              freshness,
              pageSizePerSupplier: 10,
            });
        if (!cancelled) setRows(result);
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          setError(caught instanceof Error ? caught.message : p("suppliers.errors.linesRequestFailed"));
        }
      } finally {
        if (!cancelled) setLoadingRows(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [selectedSupplierId, submittedSearch, freshness, suppliers]);

  useEffect(() => {
    if (!searchingSuppliers || loadingRows) return;
    const nextTotal = selectedSupplierId ? rows[0]?.total_count ?? 0 : rows.length;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(p("suppliers.feedback.rowsLoaded", { count: nextTotal.toLocaleString("en-US") }));
    }
    setSearchingSuppliers(false);
  }, [searchingSuppliers, loadingRows, error, rows, actionFeedback, selectedSupplierId]);

  const total = selectedSupplierId ? rows[0]?.total_count ?? 0 : rows.length;

  const supplierOptions = [
    { value: "", label: p("suppliers.filters.allSuppliers") },
    ...suppliers.map((supplier) => ({
      value: supplier.supplier_id,
      label: `${supplier.name} (${supplier.line_count.toLocaleString("en-US")})`,
    })),
  ];
  const brandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: p("suppliers.filters.newBrand") },
  ];
  const freshnessOptions = freshnessValues.map((value) => ({ value, label: p(`suppliers.freshness.${value}`) }));
  const importModeOptions = [
    { value: "replace", label: p("suppliers.importModes.replace") },
    { value: "merge", label: p("suppliers.importModes.merge") },
  ];
  const selectableSupplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: `${supplier.name} (${supplier.line_count.toLocaleString("en-US")})`,
  }));
  const importSupplierOptions = [...selectableSupplierOptions, { value: "__new__", label: p("suppliers.filters.newSupplier") }];

  const columns = useMemo(
    () => [
      {
        key: "supplier",
        header: p("columns.supplier"),
        render: (row: SupplierPriceRow) =>
          row.supplier_name || suppliers.find((item) => item.supplier_id === selectedSupplierId)?.name || "-",
      },
      { key: "code", header: p("columns.code"), render: (row: SupplierPriceRow) => formatBrandAwareProductCode(row.product_code, row.brand || row.supplier_name || "") },
      { key: "brand", header: p("columns.brand"), render: (row: SupplierPriceRow) => <BrandPill brand={row.brand} compact /> },
      {
        key: "name",
        header: p("columns.name"),
        render: (row: SupplierPriceRow) => (row.is_placeholder ? p("suppliers.empty.noPriceForSupplier") : row.description || "-"),
      },
      { key: "oem", header: "OEM", render: (row: SupplierPriceRow) => row.oem_no || "-" },
      { key: "price", header: p("columns.buy"), render: (row: SupplierPriceRow) => row.buy_price ?? "-" },
      { key: "currency", header: p("columns.currency"), render: (row: SupplierPriceRow) => row.currency || "-" },
      { key: "date", header: p("columns.priceDate"), render: (row: SupplierPriceRow) => row.price_date || "-" },
      { key: "freshness", header: p("columns.freshness"), render: (row: SupplierPriceRow) => (row.freshness ? p(`suppliers.freshness.${row.freshness}`) : "-") },
    ],
    [selectedSupplierId, suppliers, t],
  );

  useEffect(() => {
    if (!showManualPriceDialog) return;

    const brand = manualPriceDraft.brand.trim();
    const productCode = manualPriceDraft.product_code.trim();
    const normalizedCode = normalizePartCode(productCode);

    if (!brand || normalizedCode.length < 3) {
      setCatalogMatch(null);
      setResolvingCatalogMatch(false);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      try {
        setResolvingCatalogMatch(true);
        const rows = await fetchCloudCatalog({
          brandName: brand,
          search: productCode,
          page: 1,
          pageSize: 20,
        });
        if (cancelled) return;
        const match =
          rows.find((row) => normalizePartCode(row.product_code) === normalizedCode) || null;
        setCatalogMatch(match);
        if (match) {
          setManualPriceDraft((current) => ({
            ...current,
            description: match.description || current.description,
            oem_no: match.oem_no || current.oem_no,
          }));
        }
      } catch {
        if (!cancelled) {
          setCatalogMatch(null);
        }
      } finally {
        if (!cancelled) {
          setResolvingCatalogMatch(false);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [showManualPriceDialog, manualPriceDraft.brand, manualPriceDraft.product_code]);

  async function reloadSupplierRows(nextSearch = submittedSearch, nextFreshness = freshness, supplierId = selectedSupplierId) {
    if (!supplierId && !nextSearch.trim()) {
      setRows([]);
      return;
    }

    setLoadingRows(true);
    setError("");
    setStatus("");
    try {
      const result = supplierId
        ? await fetchCloudSupplierPrices({
            supplierId,
            search: nextSearch,
            freshness: nextFreshness,
            page: 1,
            pageSize: 50,
          })
        : await fetchCloudSupplierPricesAcrossSuppliers({
            suppliers,
            search: nextSearch,
            freshness: nextFreshness,
            pageSizePerSupplier: 10,
          });
      setRows(result);
    } catch (caught) {
      setRows([]);
      setError(caught instanceof Error ? caught.message : p("suppliers.errors.linesRequestFailed"));
    } finally {
      setLoadingRows(false);
    }
  }

  async function handleSupplierImport(file: File) {
    const activeSupplierName =
      importSupplierId === "__new__"
        ? importSupplierName.trim()
        : suppliers.find((supplier) => supplier.supplier_id === importSupplierId)?.name || importSupplierName.trim();
    const activeImportBrand = importBrand === "__new__" ? importBrandName.trim() : importBrand;

    if (!activeSupplierName) {
      setError(p("suppliers.errors.supplierRequiredForImport"));
      return;
    }
    if (!activeImportBrand) {
      setError(p("suppliers.errors.brandRequiredForImport"));
      return;
    }

    setLoadingRows(true);
    setError("");
    setStatus("");
    setWarning("");
    setImportingSupplier(true);
    actionFeedback.begin(p("suppliers.feedback.importingCsv", { supplier: activeSupplierName, brand: activeImportBrand }));
    try {
      const text = await file.text();
      const parsedRows = parseCsv(text);
      const [header = [], ...dataRows] = parsedRows;
      const codeIndex = findSupplierImportHeaderIndex(header, "Product_Code");
      const brandIndex = findSupplierImportHeaderIndex(header, "Brand");
      const nameIndex = findSupplierImportHeaderIndex(header, "Product_Name");
      const oemIndex = findSupplierImportHeaderIndex(header, "OEM_No");
      const priceIndex = findSupplierImportHeaderIndex(header, "Buy_Price_EUR");
      const dateIndex = findSupplierImportHeaderIndex(header, "Price_Date");
      const moqIndex = findSupplierImportHeaderIndex(header, "MOQ");
      const leadIndex = findSupplierImportHeaderIndex(header, "Lead_Time_Days");
      const notesIndex = findSupplierImportHeaderIndex(header, "Notes");

      const missingRequiredHeaders = SUPPLIER_IMPORT_REQUIRED_COLUMNS.filter(
        (column) => findSupplierImportHeaderIndex(header, column) === -1,
      );
      if (missingRequiredHeaders.length) {
        throw new Error(
          p("suppliers.errors.invalidCsvHeaders", {
            missing: missingRequiredHeaders.join(", "),
            columns: SUPPLIER_IMPORT_COLUMNS.join(", "),
          }),
        );
      }

      const payload = dataRows
        .map((row) => ({
          supplier_name: activeSupplierName,
          brand: activeImportBrand || normalizeText(brandIndex === -1 ? "" : row[brandIndex]) || "Unbranded",
          product_code: normalizeText(row[codeIndex]),
          description: normalizeText(nameIndex === -1 ? "" : row[nameIndex]),
          oem_no: normalizeText(oemIndex === -1 ? "" : row[oemIndex]),
          buy_price: normalizeNumber(row[priceIndex]),
          currency: "EUR",
          moq: normalizeNumber(moqIndex === -1 ? "" : row[moqIndex]),
          lead_time_days: normalizeNumber(leadIndex === -1 ? "" : row[leadIndex]),
          notes: normalizeText(notesIndex === -1 ? "" : row[notesIndex]),
          valid_from: normalizeText(dateIndex === -1 ? "" : row[dateIndex]),
          is_active: true,
        }))
        .filter((row) => row.product_code && row.buy_price !== null);

      if (!payload.length) {
        throw new Error(p("suppliers.errors.noValidRows"));
      }

      const importResult = await bulkImportSupplierPrices(payload, {
        mode: importMode === "merge" ? "merge" : "replace",
        supplierName: activeSupplierName,
        brandName: activeImportBrand,
        onProgress: ({ processedChunks, totalChunks, processedRows, totalRows }) => {
          setStatus(
          p("suppliers.feedback.importProgress", {
            supplier: activeSupplierName,
            brand: activeImportBrand,
            processedRows,
            totalRows,
            processedChunks,
            totalChunks,
          }),
          );
        },
      });
      const refreshedSuppliers = await fetchCloudSuppliers();
      const refreshedBrands = await fetchCloudBrands();
      setSuppliers(refreshedSuppliers);
      setBrands(refreshedBrands);
      const matchedSupplier = refreshedSuppliers.find(
        (supplier) => supplier.name.trim().toLowerCase() === activeSupplierName.trim().toLowerCase(),
      );
      const matchedBrand = refreshedBrands.find((item) => item.name.trim().toLowerCase() === activeImportBrand.trim().toLowerCase());
      if (matchedSupplier) {
        setSelectedSupplierId(matchedSupplier.supplier_id);
        setImportSupplierId(matchedSupplier.supplier_id);
        setImportSupplierName(matchedSupplier.name);
      }
      if (matchedBrand) {
        setImportBrand(matchedBrand.name);
        setImportBrandName(matchedBrand.name);
      }
      await reloadSupplierRows(submittedSearch, freshness, matchedSupplier?.supplier_id || selectedSupplierId);
      setShowImportDialog(false);
      setImportFile(null);
      const completionMessage = p("suppliers.feedback.importCompletedDetailed", {
        supplier: activeSupplierName,
        brand: activeImportBrand,
        processed: importResult.processed,
        totalChunks: importResult.totalChunks,
      });
      setStatus(completionMessage);
      setWarning(
        [importResult.catalogSyncMessage, importResult.rollupRefreshMessage]
          .filter((item): item is string => Boolean(item))
          .join(" ")
          .trim(),
      );
      actionFeedback.succeed(p("suppliers.feedback.importCompleted", { supplier: activeSupplierName, brand: activeImportBrand }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : p("suppliers.errors.importFailed");
      setError(message);
      setWarning("");
      actionFeedback.fail(message);
    } finally {
      setLoadingRows(false);
      setImportingSupplier(false);
    }
  }

  async function handleManualPriceSave() {
    const supplierId = manualPriceDraft.supplier_id || selectedSupplierId;
    const supplier = suppliers.find((item) => item.supplier_id === supplierId);
    const activeBrand = manualPriceDraft.brand.trim();
    const productCode = normalizeText(manualPriceDraft.product_code);
    const buyPrice = normalizeNumber(manualPriceDraft.buy_price);

    if (!supplier?.name) {
      setError(p("suppliers.errors.supplierRequired"));
      return;
    }
    if (!activeBrand) {
      setError(p("suppliers.errors.brandRequired"));
      return;
    }
    if (!productCode) {
      setError(p("suppliers.errors.productCodeRequired"));
      return;
    }
    if (buyPrice === null) {
      setError(p("suppliers.errors.buyPriceRequired"));
      return;
    }

    try {
      setSavingManualPrice(true);
      setError("");
      setStatus("");
      actionFeedback.begin(p("suppliers.feedback.savingSupplierPrice", { code: productCode }));
      await bulkImportSupplierPrices([
        {
          supplier_name: supplier.name,
          brand: activeBrand,
          product_code: productCode,
          description: normalizeText(manualPriceDraft.description),
          oem_no: normalizeText(manualPriceDraft.oem_no),
          buy_price: buyPrice,
          currency: "EUR",
          moq: normalizeNumber(manualPriceDraft.moq),
          lead_time_days: normalizeNumber(manualPriceDraft.lead_time_days),
          notes: normalizeText(manualPriceDraft.notes),
          valid_from: normalizeText(manualPriceDraft.price_date),
          is_active: true,
        },
      ]);

      const refreshedSuppliers = await fetchCloudSuppliers();
      setSuppliers(refreshedSuppliers);
      setSelectedSupplierId(supplierId);
      await reloadSupplierRows(productCode, freshness, supplierId);
      setSearch(productCode);
      setSubmittedSearch(productCode);
      setShowManualPriceDialog(false);
      setManualPriceDraft({
        supplier_id: supplierId,
        brand: activeBrand,
        product_code: "",
        description: "",
        oem_no: "",
        buy_price: "",
        price_date: "",
        moq: "",
        lead_time_days: "",
        notes: "",
      });
      setStatus(p("suppliers.feedback.supplierPriceSaved", { code: productCode }));
      actionFeedback.succeed(p("suppliers.feedback.supplierPriceSaved", { code: productCode }));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : p("suppliers.errors.manualPriceSaveFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setSavingManualPrice(false);
    }
  }

  function handleSupplierSearchSubmit() {
    const nextSearch = search.trim();
    if (!selectedSupplierId && !nextSearch) {
      const message = p("suppliers.errors.allSuppliersSearchRequiresQuery");
      setError(message);
      actionFeedback.fail(message);
      return;
    }
    setSearchingSuppliers(true);
    actionFeedback.begin(p("suppliers.feedback.searchingRows", { query: nextSearch || p("suppliers.values.allItems") }));
    setSubmittedSearch(search);
  }

  function handleSupplierExport() {
    setExportingSuppliers(true);
    actionFeedback.begin(p("suppliers.feedback.preparingCsvExport"));
    const exportRows = [
      ["Supplier", "Product_Code", "Brand", "Product_Name", "OEM_No", "Buy_Price_EUR", "Price_Date", "MOQ", "Lead_Time_Days", "Notes"],
      ...rows.map((row) => [
        row.supplier_name || suppliers.find((supplier) => supplier.supplier_id === selectedSupplierId)?.name || "",
        formatBrandAwareProductCode(row.product_code, row.brand || row.supplier_name || ""),
        row.brand || "",
        row.is_placeholder ? p("suppliers.empty.noPriceForSupplier") : row.description || "",
        row.oem_no || "",
        row.buy_price ?? "",
        row.price_date || "",
        row.moq ?? "",
        row.lead_time_days ?? "",
        row.notes || "",
      ]),
    ];
    downloadCsv("supplier-export.csv", toCsv(exportRows));
    actionFeedback.succeed(p("suppliers.feedback.csvDownloaded"));
    setExportingSuppliers(false);
  }

  return (
    <div className="page-stack">
      <section className="section-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>{p("suppliers.title")}</h2>
            <p>{p("suppliers.subtitle")}</p>
          </div>
          <div className="toolbar toolbar--wrap">
            <Select
              label={p("fields.supplier")}
              value={selectedSupplierId}
              options={supplierOptions}
              onChange={setSelectedSupplierId}
            />
            <Input
              label={t("common.search")}
              value={search}
              onChange={setSearch}
              placeholder={p("suppliers.placeholders.search")}
              onEnter={handleSupplierSearchSubmit}
            />
            <Select label={p("fields.freshness")} value={freshness} options={freshnessOptions} onChange={setFreshness} />
            <Button
              onClick={handleSupplierSearchSubmit}
              busy={searchingSuppliers}
              busyLabel={p("busy.searching")}
            >
              {t("common.search")}
            </Button>
            <Button variant="secondary" onClick={handleSupplierExport} disabled={!rows.length} busy={exportingSuppliers} busyLabel={p("busy.preparing")}>
              {p("actions.exportCsv")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setManualPriceDraft((current) => ({
                  ...current,
                  supplier_id: selectedSupplierId || current.supplier_id || suppliers[0]?.supplier_id || "",
                  brand: current.brand || rows[0]?.brand || "",
                  product_code: search.trim() || current.product_code,
                }));
                setShowManualPriceDialog(true);
              }}
            >
              {p("suppliers.actions.addManualPrice")}
            </Button>
            <Button variant="secondary" onClick={() => setShowImportDialog(true)}>
              {p("suppliers.actions.importCsv")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                downloadSupplierTemplate();
                actionFeedback.succeed(p("suppliers.feedback.templateDownloaded"));
              }}
            >
              {p("suppliers.actions.downloadTemplate")}
            </Button>
          </div>
        </div>
        <div className="section-card__body">
          <div className="meta-row">
            <span>
            {loadingSuppliers
                ? p("suppliers.loading.suppliers")
                : loadingRows
                  ? p("suppliers.loading.rows")
                  : p("suppliers.meta.rows", { count: total.toLocaleString("en-US") })}
            </span>
            {status ? <span className="success-text">{status}</span> : null}
            {warning ? <span className="warning-text">{warning}</span> : null}
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable rows={rows} columns={columns} emptyText={loadingRows ? t("common.loadingPage") : p("suppliers.empty.noRows")} />
        </div>
      </section>

      {showImportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>{p("suppliers.import.title")}</h3>
                <p>{p("suppliers.import.subtitle")}</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label={p("fields.supplier")}
                value={importSupplierId}
                options={importSupplierOptions}
                onChange={(value) => {
                  setImportSupplierId(value);
                  if (value === "__new__") {
                    setImportSupplierName("");
                    return;
                  }
                  const matchedSupplier = suppliers.find((supplier) => supplier.supplier_id === value);
                  setImportSupplierName(matchedSupplier?.name ?? "");
                }}
              />
              <Input
                label={p("fields.supplierName")}
                value={importSupplierName}
                onChange={setImportSupplierName}
                disabled={importSupplierId !== "__new__"}
              />
              <Select
                label={p("fields.brand")}
                value={importBrand}
                options={brandOptions}
                onChange={(value) => {
                  setImportBrand(value);
                  if (value !== "__new__") {
                    setImportBrandName(value);
                  } else {
                    setImportBrandName("");
                  }
                }}
              />
              <Input
                label={p("fields.brandName")}
                value={importBrandName}
                onChange={setImportBrandName}
                disabled={importBrand !== "__new__"}
              />
              <Select label={p("fields.importMode")} value={importMode} options={importModeOptions} onChange={setImportMode} />
              <Input label={p("fields.target")} value={p("suppliers.import.cloudTarget")} onChange={() => undefined} disabled />
              <label className="field">
                <span className="field__label">{p("fields.file")}</span>
                <input
                  className="field__input"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] ?? null);
                  }}
                />
              </label>
              <Input label={p("fields.selectedFile")} value={importFile?.name ?? ""} onChange={() => undefined} disabled />
            </div>
            <div className="modal-hint">{p("suppliers.import.requiredHint")}</div>
            <div className="modal-hint">{p("suppliers.import.expectedColumns", { columns: SUPPLIER_IMPORT_COLUMNS.join(", ") })}</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadSupplierTemplate();
                  actionFeedback.succeed(p("suppliers.feedback.sampleTemplateDownloaded"));
                }}
              >
                {p("suppliers.actions.downloadSampleTemplate")}
              </Button>
            </div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowImportDialog(false);
                  setImportFile(null);
                  setImportSupplierId(selectedSupplierId || suppliers[0]?.supplier_id || "__new__");
                  setImportSupplierName(
                    suppliers.find((supplier) => supplier.supplier_id === (selectedSupplierId || suppliers[0]?.supplier_id))?.name ?? "",
                  );
                  setImportBrand("");
                  setImportBrandName("");
                }}
              >
                {p("suppliers.actions.cancelImport")}
              </Button>
              <Button
                onClick={() => {
                  if (importFile) void handleSupplierImport(importFile);
                }}
                disabled={
                  !importSupplierId ||
                  !importSupplierName.trim() ||
                  !importBrand ||
                  !(importBrand === "__new__" ? importBrandName.trim() : true) ||
                  !importMode ||
                  !importFile ||
                  loadingRows
                }
                busy={importingSupplier}
                busyLabel={p("busy.importing")}
              >
                {p("suppliers.actions.import")}
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {showManualPriceDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>{p("suppliers.manual.title")}</h3>
                <p>{p("suppliers.manual.subtitle")}</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label={p("fields.supplier")}
                value={manualPriceDraft.supplier_id}
                options={selectableSupplierOptions}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, supplier_id: value }))}
              />
              <Select
                label={p("fields.brand")}
                value={manualPriceDraft.brand}
                options={brands.map((item) => ({ value: item.name, label: item.name }))}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, brand: value }))}
              />
              <Input
                label={p("fields.productCode")}
                value={manualPriceDraft.product_code}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, product_code: value }))}
              />
              <Input
                label={p("fields.buyPriceEur")}
                value={manualPriceDraft.buy_price}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, buy_price: value }))}
                onEnter={() => void handleManualPriceSave()}
              />
              <Input
                label={p("fields.description")}
                value={manualPriceDraft.description}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, description: value }))}
              />
              <Input
                label={p("fields.oemNo")}
                value={manualPriceDraft.oem_no}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, oem_no: value }))}
              />
              <Input
                label={p("fields.priceDate")}
                type="date"
                value={manualPriceDraft.price_date}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, price_date: value }))}
              />
              <Input
                label={p("fields.moq")}
                value={manualPriceDraft.moq}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, moq: value }))}
              />
              <Input
                label={p("fields.leadTimeDays")}
                value={manualPriceDraft.lead_time_days}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, lead_time_days: value }))}
              />
              <Input
                label={p("fields.notes")}
                value={manualPriceDraft.notes}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, notes: value }))}
              />
            </div>
            {manualPriceDraft.brand.trim() && manualPriceDraft.product_code.trim() ? (
              <div className="modal-hint">
                {resolvingCatalogMatch
                  ? p("suppliers.manual.checkingCatalogMatch")
                  : catalogMatch
                    ? p("suppliers.manual.catalogMatchFound", {
                        description: catalogMatch.description || "-",
                        oem: catalogMatch.oem_no || "-",
                        hs: catalogMatch.hs_code || "-",
                        origin: catalogMatch.origin || "-",
                        weight: catalogMatch.weight_kg ?? "-",
                      })
                    : p("suppliers.manual.noCatalogMatch")}
              </div>
            ) : null}
            <div className="modal-hint">{p("suppliers.manual.pipelineHint")}</div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowManualPriceDialog(false);
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={() => void handleManualPriceSave()}
                disabled={!manualPriceDraft.supplier_id || !manualPriceDraft.brand.trim() || !manualPriceDraft.product_code.trim() || !manualPriceDraft.buy_price.trim()}
                busy={savingManualPrice}
                busyLabel={t("common.saving")}
              >
                {p("suppliers.actions.savePrice")}
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}
    </div>
  );
}

function findSupplierImportHeaderIndex(header: string[], logicalColumn: (typeof SUPPLIER_IMPORT_COLUMNS)[number]) {
  const aliases = SUPPLIER_IMPORT_HEADER_ALIASES[logicalColumn] || [logicalColumn];
  return header.findIndex((cell) => aliases.some((alias) => cell.trim().toLowerCase() === alias.toLowerCase()));
}
