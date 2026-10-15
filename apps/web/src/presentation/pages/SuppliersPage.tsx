import { SupplierReleaseReviewPanel } from "../../modules/admin/SupplierReleaseReviewPanel";
import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeBrandName, normalizePartCode } from "../../domain/shared/normalize";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCloudCatalog } from "../../infrastructure/api/catalogApi";
import { assertLegacySupplierPriceWriteAllowed, bulkImportSupplierPrices } from "../../infrastructure/api/importApi";
import {
  fetchCloudSupplierPrices,
  fetchCloudSupplierPricesAcrossSuppliers,
  fetchCloudSuppliers,
} from "../../infrastructure/api/suppliersApi";
import { downloadExportJob, startSupplierPriceListExport, waitForExportJob } from "../../infrastructure/api/exportJobsApi";
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
import {
  normalizeImportDate,
  normalizeInteger,
  normalizeNumber,
  normalizeStockQuantity,
  normalizeText,
  parseCsv,
} from "../../shared/csv";
import { formatBrandAwareProductCode } from "../../shared/productCodeDisplay";
import { downloadSupplierTemplate, VERIFIED_SUPPLIER_IMPORT_COLUMNS } from "../../shared/importTemplates";
import { useI18n } from "../../i18n/I18nProvider";
import {uploadVerifiedSupplierFile,fetchVerifiedUploadStatus,fetchVerifiedSupplierUploadOptions,isVerifiedSupplierUploadEnabled,verifiedSupplierUploadRequested} from "../../infrastructure/api/supplierVerifiedUploadApi";
import {supplierUploadStatusView,type UploadProgress} from "../../shared/supplierUploadProtocol";

const freshnessValues = ["all", "fresh", "aging", "stale", "unknown"] as const;

const SUPPLIER_IMPORT_COLUMNS = [
  "Product_Code",
  "Brand",
  "Product_Name",
  "OEM_No",
  "Buy_Price_EUR",
  "Price_Date",
  "MOQ",
  "Order_Multiple",
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
  Order_Multiple: ["Order_Multiple", "Order Multiple", "Pack_Multiple", "Pack Multiple", "Case_Qty", "Case Quantity"],
  Lead_Time_Days: ["Lead_Time_Days", "Lead Time Days", "Lead_Time", "Lead Time"],
  Notes: ["Notes", "Note", "Comment", "Comments"],
};

const SUPPLIER_IMPORT_REQUIRED_COLUMNS = ["Product_Code", "Buy_Price_EUR"] as const;

export function SuppliersPage() {
  const { t, locale } = useI18n();
  const p = (key: string, params?: Record<string, string | number>) => t(`purchases.${key}`, params);
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [importBrand, setImportBrand] = useState("");
  const [importBrandName, setImportBrandName] = useState("");
  const [exportBrand, setExportBrand] = useState("");
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
  const verifiedUploadEnabled = isVerifiedSupplierUploadEnabled();
  const uploadController = useRef<AbortController | null>(null);
  const [verifiedProgress, setVerifiedProgress] = useState<UploadProgress | null>(null);
  const [uploadSourceDate, setUploadSourceDate] = useState("");
  const verifiedUploadComplete = verifiedUploadEnabled && verifiedProgress?.phase === "verified";
  useEffect(() => () => uploadController.current?.abort(), []);
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
    order_multiple: "",
    lead_time_days: "",
    notes: "",
  });

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const result = verifiedUploadEnabled
          ? (await fetchVerifiedSupplierUploadOptions<{brands: BrandOption[]}>()).brands
          : await fetchCloudBrands();
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
        const result = verifiedUploadEnabled
          ? (await fetchVerifiedSupplierUploadOptions<{suppliers: SupplierSummary[]}>()).suppliers
          : await fetchCloudSuppliers();
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
    const nextTotal = rows.length;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(p("suppliers.feedback.rowsLoaded", { count: nextTotal.toLocaleString("en-US") }));
    }
    setSearchingSuppliers(false);
  }, [searchingSuppliers, loadingRows, error, rows, actionFeedback, selectedSupplierId]);

  const total = selectedSupplierId && rows.length ? rows[0].total_count : rows.length;

  const supplierOptions = [
    { value: "", label: p("suppliers.filters.allSuppliers") },
    ...suppliers.map((supplier) => ({
      value: supplier.supplier_id,
      label: supplier.name,
    })),
  ];
  const brandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    ...(verifiedUploadEnabled ? [] : [{ value: "__new__", label: p("suppliers.filters.newBrand") }]),
  ];
  const exportBrandOptions = [
    { value: "", label: p("suppliers.filters.selectBrand") },
    ...brands.map((item) => ({ value: item.name, label: item.name })),
  ];
  const freshnessOptions = freshnessValues.map((value) => ({ value, label: p(`suppliers.freshness.${value}`) }));
  const importModeOptions = [
    { value: "replace", label: p("suppliers.importModes.replace") },
    ...(verifiedSupplierUploadRequested ? [] : [{ value: "merge", label: p("suppliers.importModes.merge") }]),
  ];
  const selectableSupplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: supplier.name,
  }));
  const importSupplierOptions = [...selectableSupplierOptions, ...(verifiedUploadEnabled ? [] : [{ value: "__new__", label: p("suppliers.filters.newSupplier") }])];

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
      { key: "moq", header: p("fields.moq"), render: (row: SupplierPriceRow) => row.moq ?? "-" },
      { key: "orderMultiple", header: p("fields.orderMultiple"), render: (row: SupplierPriceRow) => row.order_multiple ?? "-" },
      { key: "supplierStock", header: p("fields.supplierStockQty"), render: (row: SupplierPriceRow) => row.stock_qty ?? "-" },
      { key: "validTo", header: p("fields.priceValidTo"), render: (row: SupplierPriceRow) => row.valid_to || "-" },
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

    if (verifiedSupplierUploadRequested && !verifiedUploadEnabled) {
      const message = "Verified supplier upload is not enabled for this environment.";
      setError(message); actionFeedback.fail(message); return;
    }

    if(verifiedUploadEnabled) {
      if(uploadController.current) return;
      if(importMode !== 'replace') {
        const message='Verified supplier upload requires a complete replacement price list. Merge is not supported.';
        setError(message);actionFeedback.fail(message);return;
      }
      const brand=brands.find(b=>b.name===activeImportBrand);
      if(!brand||importSupplierId==='__new__'||!uploadSourceDate) {
        const message='Select an existing supplier/brand and a source date for verified upload.';
        setError(message);actionFeedback.fail(message);return;
      }
      const controller=new AbortController();uploadController.current=controller;
      setImportingSupplier(true);setError('');setStatus('');setWarning('');
      try {
        const result=await uploadVerifiedSupplierFile(file,{supplierId:importSupplierId,brandId:brand.id,
          mode:importMode,sourceDate:uploadSourceDate},controller.signal,
          progress=>{setVerifiedProgress(progress);setStatus(progress.message);});
        const resultView=supplierUploadStatusView(result,locale==='tr');
        setVerifiedProgress(current=>current?{...current,...resultView}:current);
        setStatus(resultView.message);
        if(resultView.phase==='failed') actionFeedback.fail(resultView.message);
        // Intentionally do not close the dialog, refresh commercial prices,
        // or announce an import/publication success from a source receipt.
      } catch(caught) {
        const paused=controller.signal.aborted;
        const message=paused?'Upload paused. Select the same file to resume the same session.':caught instanceof Error?caught.message:'Upload outcome is unknown. Check this same upload.';
        setVerifiedProgress(current=>current?{...current,phase:paused?'paused':'unknown',message}:null);
        setError(message);if(!paused)actionFeedback.fail(message);
      } finally {uploadController.current=null;setImportingSupplier(false);}
      return;
    }

    setLoadingRows(true);
    setError("");
    setStatus("");
    setWarning("");
    setImportingSupplier(true);
    actionFeedback.begin(p("suppliers.feedback.importingCsv", { supplier: activeSupplierName, brand: activeImportBrand }));
    try {
      await assertLegacySupplierPriceWriteAllowed(activeImportBrand);
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
      const orderMultipleIndex = findSupplierImportHeaderIndex(header, "Order_Multiple");
      const leadIndex = findSupplierImportHeaderIndex(header, "Lead_Time_Days");
      const notesIndex = findSupplierImportHeaderIndex(header, "Notes");
      const stockQtyIndex = header.findIndex((cell) =>
        ["stock_qty", "stock qty", "stock_quantity", "stock quantity"].includes(cell.trim().toLowerCase()),
      );

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

      // A supplier import is scoped to one selected brand. Previously the
      // selected brand was written onto every row while the CSV Brand column
      // was only parsed and ignored. That allowed a Mahle file to be uploaded
      // as Gates (or vice versa) without any warning. Stop before staging when
      // the file declares a different or mixed brand.
      const fileBrands = brandIndex === -1
        ? []
        : Array.from(new Set(
          dataRows
            .map((row) => normalizeText(row[brandIndex]))
            .filter((value): value is string => Boolean(value)),
        ));
      const selectedBrandKey = normalizeBrandName(activeImportBrand).toLowerCase();
      const fileBrandKeys = new Set(fileBrands.map((value) => normalizeBrandName(value).toLowerCase()));
      const mismatchedFileBrands = fileBrands.filter(
        (value) => normalizeBrandName(value).toLowerCase() !== selectedBrandKey,
      );
      if (fileBrands.length > 1) {
        throw new Error(
          p("suppliers.errors.mixedCsvBrands", {
            brands: fileBrands.slice(0, 6).join(", "),
            suffix: fileBrands.length > 6 ? ` (+${fileBrands.length - 6} more)` : "",
          }),
        );
      }
      if (fileBrandKeys.size && mismatchedFileBrands.length) {
        throw new Error(
          p("suppliers.errors.csvBrandMismatch", {
            selected: activeImportBrand,
            found: mismatchedFileBrands.slice(0, 6).join(", "),
            suffix: mismatchedFileBrands.length > 6 ? ` (+${mismatchedFileBrands.length - 6} more)` : "",
          }),
        );
      }

      const invalidFormats: string[] = [];
      const normalizedFormats: string[] = [];
      const payload = dataRows
        .map((row, rowIndex) => {
          const spreadsheetRow = rowIndex + 2;
          const rawDate = normalizeText(dateIndex === -1 ? "" : row[dateIndex]);
          const rawMoq = normalizeText(moqIndex === -1 ? "" : row[moqIndex]);
          const rawOrderMultiple = normalizeText(orderMultipleIndex === -1 ? "" : row[orderMultipleIndex]);
          const rawLeadTime = normalizeText(leadIndex === -1 ? "" : row[leadIndex]);
          const rawStockQty = normalizeText(stockQtyIndex === -1 ? "" : row[stockQtyIndex]);
          const validFrom = rawDate ? normalizeImportDate(rawDate) : null;
          const moq = rawMoq ? normalizeInteger(rawMoq) : null;
          const orderMultiple = rawOrderMultiple ? normalizeInteger(rawOrderMultiple) : null;
          const leadTimeDays = rawLeadTime ? normalizeInteger(rawLeadTime) : null;
          const stockQty = rawStockQty ? normalizeStockQuantity(rawStockQty) : null;

          if (rawDate && !validFrom) invalidFormats.push(`row ${spreadsheetRow}: Price_Date "${rawDate}"`);
          if (rawDate && validFrom && rawDate !== validFrom) {
            normalizedFormats.push(`row ${spreadsheetRow}: Price_Date "${rawDate}" → ${validFrom}`);
          }
          if (rawMoq && moq === null) invalidFormats.push(`row ${spreadsheetRow}: MOQ "${rawMoq}" (integer required)`);
          if (rawOrderMultiple && orderMultiple === null) {
            invalidFormats.push(`row ${spreadsheetRow}: Order_Multiple "${rawOrderMultiple}" (integer required)`);
          }
          if (rawLeadTime && leadTimeDays === null) {
            invalidFormats.push(`row ${spreadsheetRow}: Lead_Time_Days "${rawLeadTime}" (integer required)`);
          }
          if (rawStockQty && stockQty === null) {
            invalidFormats.push(`row ${spreadsheetRow}: Stock_Qty "${rawStockQty}" (integer required)`);
          } else if (rawStockQty && /^\d+[.,]\d{2}$/.test(rawStockQty)) {
            normalizedFormats.push(`row ${spreadsheetRow}: Stock_Qty "${rawStockQty}" → ${stockQty}`);
          }

          return {
            supplier_name: activeSupplierName,
            brand: activeImportBrand || normalizeText(brandIndex === -1 ? "" : row[brandIndex]) || "Unbranded",
            product_code: normalizeText(row[codeIndex]),
            description: normalizeText(nameIndex === -1 ? "" : row[nameIndex]),
            oem_no: normalizeText(oemIndex === -1 ? "" : row[oemIndex]),
            buy_price: normalizeNumber(row[priceIndex]),
            currency: "EUR",
            moq,
            order_multiple: orderMultiple,
            lead_time_days: leadTimeDays,
            notes: normalizeText(notesIndex === -1 ? "" : row[notesIndex]),
            valid_from: validFrom,
            // Current supplier-price RPCs ignore this optional field, but
            // normalising it here prevents legacy/import-worker variants from
            // receiving a decimal string such as "1.64".
            ...(stockQtyIndex === -1 ? {} : { stock_qty: stockQty }),
            is_active: true,
          };
        })
        .filter((row) => row.product_code && row.buy_price !== null);

      if (invalidFormats.length) {
        throw new Error(
          p("suppliers.errors.invalidCsvValues", {
            details: invalidFormats.slice(0, 8).join("; "),
            suffix: invalidFormats.length > 8 ? ` (+${invalidFormats.length - 8} more)` : "",
          }),
        );
      }
      if (normalizedFormats.length) {
        setWarning(
          p("suppliers.warnings.normalizedCsvValues", {
            details: normalizedFormats.slice(0, 8).join("; "),
            suffix: normalizedFormats.length > 8 ? ` (+${normalizedFormats.length - 8} more)` : "",
          }),
        );
      }

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
      const rawMessage = caught instanceof Error ? caught.message : p("suppliers.errors.importFailed");
      const message = rawMessage.includes("LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED")
        ? p("suppliers.errors.verifiedUploadRequired")
        : rawMessage;
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
      await assertLegacySupplierPriceWriteAllowed(activeBrand);
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
          order_multiple: normalizeNumber(manualPriceDraft.order_multiple),
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
        order_multiple: "",
        lead_time_days: "",
        notes: "",
      });
      setStatus(p("suppliers.feedback.supplierPriceSaved", { code: productCode }));
      actionFeedback.succeed(p("suppliers.feedback.supplierPriceSaved", { code: productCode }));
    } catch (caught) {
      const rawMessage = caught instanceof Error ? caught.message : p("suppliers.errors.manualPriceSaveFailed");
      const message = rawMessage.includes("LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED")
        ? p("suppliers.errors.verifiedUploadRequired")
        : rawMessage;
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

  async function handleSupplierExport() {
    if (!selectedSupplierId) {
      const message = p("suppliers.errors.supplierRequiredForExport");
      setError(message);
      actionFeedback.fail(message);
      return;
    }
    if (!exportBrand) {
      const message = p("suppliers.errors.brandRequiredForExport");
      setError(message);
      actionFeedback.fail(message);
      return;
    }

    setExportingSuppliers(true);
    setError("");
    actionFeedback.begin(p("suppliers.feedback.preparingCsvExport"));
    try {
      const initialJob = await startSupplierPriceListExport({
        supplierId: selectedSupplierId,
        brandName: exportBrand,
        search: submittedSearch,
        freshness,
      });
      const readyJob = await waitForExportJob(initialJob, (job) => {
        const progress = job.progressTotal
          ? ` ${job.progressDone.toLocaleString("en-US")} / ${job.progressTotal.toLocaleString("en-US")}`
          : job.progressDone ? ` ${job.progressDone.toLocaleString("en-US")}` : "";
        actionFeedback.begin(`${p("suppliers.feedback.preparingCsvExport")}${progress}`);
      });
      if (!readyJob.rowCount) throw new Error(p("suppliers.empty.noRows"));
      await downloadExportJob(readyJob.id);
      actionFeedback.succeed(p("suppliers.feedback.csvDownloaded"));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : p("suppliers.errors.linesRequestFailed");
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setExportingSuppliers(false);
    }
  }

  function closeImportDialog() {
    uploadController.current?.abort();
    setShowImportDialog(false);
    setImportFile(null);
    setVerifiedProgress(null);
    setUploadSourceDate('');
    setImportSupplierId(selectedSupplierId || suppliers[0]?.supplier_id || "__new__");
    setImportSupplierName(
      suppliers.find((supplier) => supplier.supplier_id === (selectedSupplierId || suppliers[0]?.supplier_id))?.name ?? "",
    );
    setImportBrand("");
    setImportBrandName("");
  }

  const visibleSupplierRows = total ?? rows.length;

  return (
    <div className="page-stack">
      <section className="supplier-command-hero">
        <div>
          <span className="supplier-command-hero__eyebrow">{p("suppliers.title")}</span>
          <h2>{p("suppliers.subtitle")}</h2>
          <p>Upload, validate and publish supplier prices from one controlled workspace.</p>
        </div>
        <div className="supplier-command-hero__metrics" aria-label="Supplier upload summary">
          <div><strong>{visibleSupplierRows.toLocaleString("en-US")}</strong><span>visible rows</span></div>
          <div><strong>{suppliers.length.toLocaleString("en-US")}</strong><span>suppliers</span></div>
          <div><strong>{verifiedUploadEnabled ? "3" : "2"}</strong><span>release gates</span></div>
        </div>
      </section>
      {import.meta.env.VITE_SUPPLIER_RELEASE_REVIEW_ENABLED === "true" ? <SupplierReleaseReviewPanel locale={locale} /> : null}
      <section className="section-card supplier-workspace-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>{p("suppliers.title")}</h2>
            <p>{p("suppliers.subtitle")}</p>
          </div>
          <div className="supplier-toolbar supplier-toolbar--browse">
            <Select
              label={p("fields.supplier")}
              value={selectedSupplierId}
              options={supplierOptions}
              onChange={setSelectedSupplierId}
            />
            <Select label={p("suppliers.filters.exportBrand")} value={exportBrand} options={exportBrandOptions} onChange={setExportBrand} />
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
            <Button variant="secondary" onClick={() => void handleSupplierExport()} disabled={!selectedSupplierId || !exportBrand} busy={exportingSuppliers} busyLabel={p("busy.preparing")}>
              {p("actions.exportCsv")}
            </Button>
          </div>
          <div className="supplier-toolbar supplier-toolbar--actions">
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
                downloadSupplierTemplate({ verified: verifiedUploadEnabled });
                actionFeedback.succeed(p("suppliers.feedback.templateDownloaded"));
              }}
            >
              {p("suppliers.actions.downloadTemplate")}
            </Button>
          </div>
        </div>
        <div className="section-card__body">
          <p className="muted-text">{p("suppliers.export.scopeHint")}</p>

          <div className="meta-row">
            <span>
            {loadingSuppliers
                ? p("suppliers.loading.suppliers")
                : loadingRows
                  ? p("suppliers.loading.rows")
                  : total == null
                    ? p("suppliers.meta.previewRows", { count: rows.length.toLocaleString("en-US") })
                    : p("suppliers.meta.rows", { count: total.toLocaleString("en-US") })}
            </span>
            {status ? <span className="success-text">{status}</span> : null}
            {warning ? <span className="warning-text">{warning}</span> : null}
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable rows={rows} columns={columns} emptyText={loadingRows ? t("common.loadingPage") : p("suppliers.empty.noPreviewRows")} />
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
              {verifiedUploadEnabled ? <Input label="Source date" type="date" value={uploadSourceDate} onChange={setUploadSourceDate} disabled={importingSupplier}/> : null}
              <Input label={p("fields.target")} value={p("suppliers.import.cloudTarget")} onChange={() => undefined} disabled />
              <label className="field">
                <span className="field__label">{p("fields.file")}</span>
                <input
                  className="field__input"
                  type="file"
                  accept={verifiedUploadEnabled ? ".csv,.xlsx" : ".csv,text/csv"}
                  disabled={importingSupplier}
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] ?? null);
                  }}
                />
              </label>
              <Input label={p("fields.selectedFile")} value={importFile?.name ?? ""} onChange={() => undefined} disabled />
            </div>
            {verifiedUploadEnabled&&verifiedProgress ? <section className="section-card" aria-live="polite">
              <h4>Verified supplier upload — {verifiedProgress.phase}</h4>
              <progress style={{width:'100%'}} max={verifiedProgress.totalBytes||1} value={verifiedProgress.bytes}/>
              <p>{verifiedProgress.message}</p>
              <p>{verifiedProgress.bytes.toLocaleString()} / {verifiedProgress.totalBytes.toLocaleString()} bytes</p>
              {verifiedProgress.sessionId?<p>Upload session: {verifiedProgress.sessionId}</p>:null}
              <div className="toolbar toolbar--wrap">
                {importingSupplier?<Button variant="secondary" onClick={()=>uploadController.current?.abort()}>Pause upload</Button>:null}
                {verifiedProgress.sessionId&&!importingSupplier?<Button variant="secondary" onClick={async()=>{
                  const controller=new AbortController();uploadController.current=controller;setImportingSupplier(true);
                  try {const result=await fetchVerifiedUploadStatus(verifiedProgress.sessionId!,controller.signal);
                    const resultView=supplierUploadStatusView(result,locale==='tr');
                    setVerifiedProgress(current=>current?{...current,...resultView}:current);
                    setStatus(resultView.message);
                    if(resultView.phase==='failed') actionFeedback.fail(resultView.message);
                    setError('');
                  }catch(e){setError(e instanceof Error?e.message:'Status unavailable.');}
                  finally{uploadController.current=null;setImportingSupplier(false);}
                }}>Check this upload</Button>:null}
              </div>
            </section>:null}
            <div className="modal-hint">{p(verifiedUploadEnabled ? "suppliers.import.verifiedRequiredHint" : "suppliers.import.requiredHint")}</div>
            <div className="modal-hint">{p("suppliers.import.expectedColumns", { columns: (verifiedUploadEnabled ? VERIFIED_SUPPLIER_IMPORT_COLUMNS : SUPPLIER_IMPORT_COLUMNS).join(", ") })}</div>
            {verifiedUploadEnabled ? <div className="modal-hint">{p("suppliers.import.verifiedMetadataHint")}</div> : null}
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadSupplierTemplate({ verified: verifiedUploadEnabled });
                  actionFeedback.succeed(p("suppliers.feedback.sampleTemplateDownloaded"));
                }}
              >
                {p("suppliers.actions.downloadSampleTemplate")}
              </Button>
            </div>
            <div className="modal-actions">
              {verifiedUploadComplete ? <Button onClick={closeImportDialog}>
                {t("common.close")}
              </Button> : <>
                <Button variant="secondary" onClick={closeImportDialog}>
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
                    (verifiedUploadEnabled&&!uploadSourceDate) ||
                    loadingRows
                  }
                  busy={importingSupplier}
                  busyLabel={p("busy.importing")}
                >
                  {verifiedUploadEnabled?'Upload / resume same file':p("suppliers.actions.import")}
                </Button>
              </>}
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
                label={p("fields.orderMultiple")}
                value={manualPriceDraft.order_multiple}
                onChange={(value) => setManualPriceDraft((current) => ({ ...current, order_multiple: value }))}
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
