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

const freshnessOptions = [
  { value: "all", label: "All prices" },
  { value: "fresh", label: "Fresh" },
  { value: "aging", label: "Aging" },
  { value: "stale", label: "Stale" },
  { value: "unknown", label: "Unknown" },
];

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
          setError(caught instanceof Error ? caught.message : "Supplier request failed");
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
          setError(caught instanceof Error ? caught.message : "Supplier lines request failed");
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
      actionFeedback.succeed(`${nextTotal.toLocaleString("en-US")} supplier rows loaded.`);
    }
    setSearchingSuppliers(false);
  }, [searchingSuppliers, loadingRows, error, rows, actionFeedback, selectedSupplierId]);

  const total = selectedSupplierId ? rows[0]?.total_count ?? 0 : rows.length;

  const supplierOptions = [
    { value: "", label: "All suppliers" },
    ...suppliers.map((supplier) => ({
      value: supplier.supplier_id,
      label: `${supplier.name} (${supplier.line_count.toLocaleString("en-US")})`,
    })),
  ];
  const brandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: "New brand..." },
  ];
  const importModeOptions = [
    { value: "replace", label: "Replace selected supplier list" },
    { value: "merge", label: "Merge into selected supplier list" },
  ];
  const selectableSupplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: `${supplier.name} (${supplier.line_count.toLocaleString("en-US")})`,
  }));
  const importSupplierOptions = [...selectableSupplierOptions, { value: "__new__", label: "New supplier..." }];

  const columns = useMemo(
    () => [
      {
        key: "supplier",
        header: "Supplier",
        render: (row: SupplierPriceRow) =>
          row.supplier_name || suppliers.find((item) => item.supplier_id === selectedSupplierId)?.name || "-",
      },
      { key: "code", header: "Code", render: (row: SupplierPriceRow) => formatBrandAwareProductCode(row.product_code, row.brand || row.supplier_name || "") },
      { key: "brand", header: "Brand", render: (row: SupplierPriceRow) => <BrandPill brand={row.brand} compact /> },
      {
        key: "name",
        header: "Name",
        render: (row: SupplierPriceRow) => (row.is_placeholder ? "No price found for this supplier" : row.description || "-"),
      },
      { key: "oem", header: "OEM", render: (row: SupplierPriceRow) => row.oem_no || "-" },
      { key: "price", header: "Buy", render: (row: SupplierPriceRow) => row.buy_price ?? "-" },
      { key: "currency", header: "Currency", render: (row: SupplierPriceRow) => row.currency || "-" },
      { key: "date", header: "Price Date", render: (row: SupplierPriceRow) => row.price_date || "-" },
      { key: "freshness", header: "Freshness", render: (row: SupplierPriceRow) => row.freshness || "-" },
    ],
    [selectedSupplierId, suppliers],
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
      setError(caught instanceof Error ? caught.message : "Supplier lines request failed");
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
      setError("Select an existing supplier or enter a new supplier name before import");
      return;
    }
    if (!activeImportBrand) {
      setError("Supplier import requires a brand selection");
      return;
    }

    setLoadingRows(true);
    setError("");
    setStatus("");
    setWarning("");
    setImportingSupplier(true);
    actionFeedback.begin(`Importing supplier CSV for ${activeSupplierName} / ${activeImportBrand}...`);
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
          `Supplier CSV headers are invalid. Missing: ${missingRequiredHeaders.join(", ")}. Use template columns: ${SUPPLIER_IMPORT_COLUMNS.join(", ")}`,
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
        throw new Error("CSV did not contain any valid supplier price rows");
      }

      const importResult = await bulkImportSupplierPrices(payload, {
        mode: importMode === "merge" ? "merge" : "replace",
        supplierName: activeSupplierName,
        brandName: activeImportBrand,
        onProgress: ({ processedChunks, totalChunks, processedRows, totalRows }) => {
          setStatus(
            `Supplier import running for ${activeSupplierName} / ${activeImportBrand}: ${processedRows}/${totalRows} rows (${processedChunks}/${totalChunks} batches).`,
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
      const completionMessage = `Supplier import completed for ${activeSupplierName} / ${activeImportBrand}. ${importResult.processed} rows processed in ${importResult.totalChunks} batches.`;
      setStatus(completionMessage);
      setWarning(
        [importResult.catalogSyncMessage, importResult.rollupRefreshMessage]
          .filter((item): item is string => Boolean(item))
          .join(" ")
          .trim(),
      );
      actionFeedback.succeed(`Supplier import completed for ${activeSupplierName} / ${activeImportBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Supplier import failed";
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
      setError("Supplier is required");
      return;
    }
    if (!activeBrand) {
      setError("Brand is required");
      return;
    }
    if (!productCode) {
      setError("Product code is required");
      return;
    }
    if (buyPrice === null) {
      setError("Buy price is required");
      return;
    }

    try {
      setSavingManualPrice(true);
      setError("");
      setStatus("");
      actionFeedback.begin(`Saving supplier price for ${productCode}...`);
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
      setStatus(`Supplier price saved for ${productCode}.`);
      actionFeedback.succeed(`Supplier price saved for ${productCode}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Manual supplier price save failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setSavingManualPrice(false);
    }
  }

  function handleSupplierSearchSubmit() {
    const nextSearch = search.trim();
    if (!selectedSupplierId && !nextSearch) {
      const message = "All suppliers search requires a part number, OEM, or name.";
      setError(message);
      actionFeedback.fail(message);
      return;
    }
    setSearchingSuppliers(true);
    actionFeedback.begin(`Searching supplier rows for ${nextSearch || "all items"}...`);
    setSubmittedSearch(search);
  }

  function handleSupplierExport() {
    setExportingSuppliers(true);
    actionFeedback.begin("Preparing supplier CSV export...");
    const exportRows = [
      ["Supplier", "Product_Code", "Brand", "Product_Name", "OEM_No", "Buy_Price_EUR", "Price_Date", "MOQ", "Lead_Time_Days", "Notes"],
      ...rows.map((row) => [
        row.supplier_name || suppliers.find((supplier) => supplier.supplier_id === selectedSupplierId)?.name || "",
        formatBrandAwareProductCode(row.product_code, row.brand || row.supplier_name || ""),
        row.brand || "",
        row.is_placeholder ? "No price found for this supplier" : row.description || "",
        row.oem_no || "",
        row.buy_price ?? "",
        row.price_date || "",
        row.moq ?? "",
        row.lead_time_days ?? "",
        row.notes || "",
      ]),
    ];
    downloadCsv("supplier-export.csv", toCsv(exportRows));
    actionFeedback.succeed("Supplier CSV downloaded.");
    setExportingSuppliers(false);
  }

  return (
    <div className="page-stack">
      <section className="section-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>Suppliers</h2>
            <p>Live supplier price feed from Supabase RPCs.</p>
          </div>
          <div className="toolbar toolbar--wrap">
            <Select
              label="Supplier"
              value={selectedSupplierId}
              options={supplierOptions}
              onChange={setSelectedSupplierId}
            />
            <Input
              label="Search"
              value={search}
              onChange={setSearch}
              placeholder="Product code, OEM, name"
              onEnter={handleSupplierSearchSubmit}
            />
            <Select label="Freshness" value={freshness} options={freshnessOptions} onChange={setFreshness} />
            <Button
              onClick={handleSupplierSearchSubmit}
              busy={searchingSuppliers}
              busyLabel="Searching..."
            >
              Search
            </Button>
            <Button variant="secondary" onClick={handleSupplierExport} disabled={!rows.length} busy={exportingSuppliers} busyLabel="Preparing...">
              Export CSV
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
              Add Manual Price
            </Button>
            <Button variant="secondary" onClick={() => setShowImportDialog(true)}>
              Import CSV
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                downloadSupplierTemplate();
                actionFeedback.succeed("Supplier import template downloaded.");
              }}
            >
              Download Template
            </Button>
          </div>
        </div>
        <div className="section-card__body">
          <div className="meta-row">
            <span>
            {loadingSuppliers
                ? "Loading suppliers..."
                : loadingRows
                  ? "Loading supplier rows..."
                  : `${total.toLocaleString("en-US")} supplier rows`}
            </span>
            {status ? <span className="success-text">{status}</span> : null}
            {warning ? <span className="warning-text">{warning}</span> : null}
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable rows={rows} columns={columns} emptyText={loadingRows ? "Loading..." : "No supplier rows found"} />
        </div>
      </section>

      {showImportDialog ? (
        <div className="modal-backdrop">
          <DraggableSurface className="modal-card" dragHandleSelector=".draggable-surface__handle">
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>Supplier CSV Import</h3>
                <p>All fields in this screen must be completed before import.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Supplier"
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
                label="Supplier Name"
                value={importSupplierName}
                onChange={setImportSupplierName}
                disabled={importSupplierId !== "__new__"}
              />
              <Select
                label="Brand"
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
                label="Brand Name"
                value={importBrandName}
                onChange={setImportBrandName}
                disabled={importBrand !== "__new__"}
              />
              <Select label="Import Mode" value={importMode} options={importModeOptions} onChange={setImportMode} />
              <Input label="Target" value="Cloud supplier import" onChange={() => undefined} disabled />
              <label className="field">
                <span className="field__label">File</span>
                <input
                  className="field__input"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] ?? null);
                  }}
                />
              </label>
              <Input label="Selected file" value={importFile?.name ?? ""} onChange={() => undefined} disabled />
            </div>
            <div className="modal-hint">Supplier, supplier name, brand, import mode, target, and file are required.</div>
            <div className="modal-hint">Expected columns: {SUPPLIER_IMPORT_COLUMNS.join(", ")}</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadSupplierTemplate();
                  actionFeedback.succeed("Supplier sample template downloaded.");
                }}
              >
                Download Sample Template
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
                Cancel Import
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
                busyLabel="Importing..."
              >
                Import
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
                <h3>Manual Supplier Price</h3>
                <p>Add or update one supplier price row for a specific part number.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Supplier"
                value={manualPriceDraft.supplier_id}
                options={selectableSupplierOptions}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, supplier_id: value }))}
              />
              <Select
                label="Brand"
                value={manualPriceDraft.brand}
                options={brands.map((item) => ({ value: item.name, label: item.name }))}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, brand: value }))}
              />
              <Input
                label="Product Code"
                value={manualPriceDraft.product_code}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, product_code: value }))}
              />
              <Input
                label="Buy Price EUR"
                value={manualPriceDraft.buy_price}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, buy_price: value }))}
                onEnter={() => void handleManualPriceSave()}
              />
              <Input
                label="Description"
                value={manualPriceDraft.description}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, description: value }))}
              />
              <Input
                label="OEM No"
                value={manualPriceDraft.oem_no}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, oem_no: value }))}
              />
              <Input
                label="Price Date"
                type="date"
                value={manualPriceDraft.price_date}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, price_date: value }))}
              />
              <Input
                label="MOQ"
                value={manualPriceDraft.moq}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, moq: value }))}
              />
              <Input
                label="Lead Time Days"
                value={manualPriceDraft.lead_time_days}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, lead_time_days: value }))}
              />
              <Input
                label="Notes"
                value={manualPriceDraft.notes}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, notes: value }))}
              />
            </div>
            {manualPriceDraft.brand.trim() && manualPriceDraft.product_code.trim() ? (
              <div className="modal-hint">
                {resolvingCatalogMatch
                  ? "Checking catalog match..."
                  : catalogMatch
                    ? `Catalog match found: ${catalogMatch.description || "-"} | OEM: ${catalogMatch.oem_no || "-"} | HS: ${catalogMatch.hs_code || "-"} | Origin: ${catalogMatch.origin || "-"} | Weight: ${catalogMatch.weight_kg ?? "-"}`
                    : "No catalog match found for this brand / part number."}
              </div>
            ) : null}
            <div className="modal-hint">This uses the same supplier import pipeline, but only for one part number.</div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowManualPriceDialog(false);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleManualPriceSave()}
                disabled={!manualPriceDraft.supplier_id || !manualPriceDraft.brand.trim() || !manualPriceDraft.product_code.trim() || !manualPriceDraft.buy_price.trim()}
                busy={savingManualPrice}
                busyLabel="Saving..."
              >
                Save Price
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
