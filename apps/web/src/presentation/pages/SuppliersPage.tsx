import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { bulkImportSupplierPrices } from "../../infrastructure/api/importApi";
import { fetchCloudSupplierPrices, fetchCloudSuppliers } from "../../infrastructure/api/suppliersApi";
import type { BrandOption } from "../../types/brand";
import type { SupplierPriceRow, SupplierSummary } from "../../types/suppliers";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { downloadCsv, normalizeNumber, normalizeText, parseCsv, toCsv } from "../../shared/csv";
import { downloadSupplierTemplate } from "../../shared/importTemplates";

const freshnessOptions = [
  { value: "all", label: "All prices" },
  { value: "fresh", label: "Fresh" },
  { value: "aging", label: "Aging" },
  { value: "stale", label: "Stale" },
  { value: "unknown", label: "Unknown" },
];

export function SuppliersPage() {
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [importBrand, setImportBrand] = useState("");
  const [importBrandName, setImportBrandName] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
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
  const [importingSupplier, setImportingSupplier] = useState(false);
  const [searchingSuppliers, setSearchingSuppliers] = useState(false);
  const [exportingSuppliers, setExportingSuppliers] = useState(false);

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
        setSelectedSupplierId((current) => current || defaultSupplierId);
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
      if (!selectedSupplierId) {
        setRows([]);
        return;
      }

      setLoadingRows(true);
      setError("");
      try {
        const result = await fetchCloudSupplierPrices({
          supplierId: selectedSupplierId,
          search: submittedSearch,
          freshness,
          page: 1,
          pageSize: 50,
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
  }, [selectedSupplierId, submittedSearch, freshness]);

  useEffect(() => {
    if (!searchingSuppliers || loadingRows) return;
    const nextTotal = rows[0]?.total_count ?? 0;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(`${nextTotal.toLocaleString("en-US")} supplier rows loaded.`);
    }
    setSearchingSuppliers(false);
  }, [searchingSuppliers, loadingRows, error, rows, actionFeedback]);

  const total = rows[0]?.total_count ?? 0;

  const supplierOptions = [
    ...suppliers.map((supplier) => ({
      value: supplier.supplier_id,
      label: `${supplier.name} (${supplier.line_count.toLocaleString("en-US")})`,
    })),
    { value: "__new__", label: "New supplier..." },
  ];
  const brandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: "New brand..." },
  ];
  const importModeOptions = [
    { value: "replace", label: "Replace selected supplier list" },
    { value: "merge", label: "Merge into selected supplier list" },
  ];

  const columns = useMemo(
    () => [
      { key: "code", header: "Code", render: (row: SupplierPriceRow) => row.product_code },
      { key: "brand", header: "Brand", render: (row: SupplierPriceRow) => row.brand || "-" },
      { key: "name", header: "Name", render: (row: SupplierPriceRow) => row.description || "-" },
      { key: "oem", header: "OEM", render: (row: SupplierPriceRow) => row.oem_no || "-" },
      { key: "price", header: "Buy", render: (row: SupplierPriceRow) => row.buy_price ?? "-" },
      { key: "currency", header: "Currency", render: (row: SupplierPriceRow) => row.currency || "-" },
      { key: "date", header: "Price Date", render: (row: SupplierPriceRow) => row.price_date || "-" },
      { key: "freshness", header: "Freshness", render: (row: SupplierPriceRow) => row.freshness || "-" },
    ],
    [],
  );

  async function reloadSupplierRows(nextSearch = submittedSearch, nextFreshness = freshness, supplierId = selectedSupplierId) {
    if (!supplierId) {
      setRows([]);
      return;
    }

    setLoadingRows(true);
    setError("");
    setStatus("");
    try {
      const result = await fetchCloudSupplierPrices({
        supplierId,
        search: nextSearch,
        freshness: nextFreshness,
        page: 1,
        pageSize: 50,
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
    setImportingSupplier(true);
    actionFeedback.begin(`Importing supplier CSV for ${activeSupplierName} / ${activeImportBrand}...`);
    try {
      const text = await file.text();
      const parsedRows = parseCsv(text);
      const [header = [], ...dataRows] = parsedRows;
      const indexOf = (name: string) => header.findIndex((cell) => cell.trim().toLowerCase() === name.toLowerCase());
      const codeIndex = indexOf("Product_Code");
      const brandIndex = indexOf("Brand");
      const nameIndex = indexOf("Product_Name");
      const oemIndex = indexOf("OEM_No");
      const priceIndex = indexOf("Buy_Price_EUR");
      const dateIndex = indexOf("Price_Date");
      const moqIndex = indexOf("MOQ");
      const leadIndex = indexOf("Lead_Time_Days");
      const notesIndex = indexOf("Notes");

      const payload = dataRows
        .map((row) => ({
          supplier_name: activeSupplierName,
          brand: activeImportBrand || normalizeText(row[brandIndex]) || "Unbranded",
          product_code: normalizeText(row[codeIndex]),
          description: normalizeText(row[nameIndex]),
          oem_no: normalizeText(row[oemIndex]),
          buy_price: normalizeNumber(row[priceIndex]),
          currency: "EUR",
          moq: normalizeNumber(row[moqIndex]),
          lead_time_days: normalizeNumber(row[leadIndex]),
          notes: normalizeText(row[notesIndex]),
          valid_from: normalizeText(row[dateIndex]),
          is_active: true,
        }))
        .filter((row) => row.product_code && row.buy_price !== null);

      if (!payload.length) {
        throw new Error("CSV did not contain any valid supplier price rows");
      }

      await bulkImportSupplierPrices(payload);
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
      setStatus(`Supplier import completed for ${activeSupplierName} / ${activeImportBrand}.`);
      actionFeedback.succeed(`Supplier import completed for ${activeSupplierName} / ${activeImportBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Supplier import failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setLoadingRows(false);
      setImportingSupplier(false);
    }
  }

  function handleSupplierExport() {
    setExportingSuppliers(true);
    actionFeedback.begin("Preparing supplier CSV export...");
    const exportRows = [
      ["Product_Code", "Brand", "Product_Name", "OEM_No", "Buy_Price_EUR", "Price_Date", "MOQ", "Lead_Time_Days", "Notes"],
      ...rows.map((row) => [
        row.product_code,
        row.brand || "",
        row.description || "",
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
            <Input label="Search" value={search} onChange={setSearch} placeholder="Product code, OEM, name" />
            <Select label="Freshness" value={freshness} options={freshnessOptions} onChange={setFreshness} />
            <Button
              onClick={() => {
                setSearchingSuppliers(true);
                actionFeedback.begin(`Searching supplier rows for ${search.trim() || "all items"}...`);
                setSubmittedSearch(search);
              }}
              busy={searchingSuppliers}
              busyLabel="Searching..."
            >
              Search
            </Button>
            <Button variant="secondary" onClick={handleSupplierExport} disabled={!rows.length} busy={exportingSuppliers} busyLabel="Preparing...">
              Export CSV
            </Button>
            <Button variant="secondary" onClick={() => setShowImportDialog(true)}>
              Import CSV
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
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable rows={rows} columns={columns} emptyText={loadingRows ? "Loading..." : "No supplier rows found"} />
        </div>
      </section>

      {showImportDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-card__header">
              <div>
                <h3>Supplier CSV Import</h3>
                <p>All fields in this screen must be completed before import.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Supplier"
                value={importSupplierId}
                options={supplierOptions}
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
          </div>
        </div>
      ) : null}
    </div>
  );
}
