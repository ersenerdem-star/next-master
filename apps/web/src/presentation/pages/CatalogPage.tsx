import { useEffect, useMemo, useState } from "react";
import { normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { syncBrandCatalogFromSpareto } from "../../infrastructure/api/adminApi";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { createCloudCatalogRow, deleteCloudCatalogRow, fetchCatalogExportRows, fetchCatalogRowsByCodes, fetchCloudCatalog, updateCloudCatalogRow } from "../../infrastructure/api/catalogApi";
import { createCodeReference, fetchCatalogReferenceCoverage, inspectCodeReferenceUsage } from "../../infrastructure/api/codeReferencesApi";
import { bulkImportCatalog } from "../../infrastructure/api/importApi";
import { matchesOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";
import type { BrandOption } from "../../types/brand";
import type { CatalogRow } from "../../types/catalog";
import type { CodeReferenceUsage } from "../../types/codeReferences";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { downloadCsv, normalizeNumber, normalizeText, parseCsv, toCsv } from "../../shared/csv";
import { downloadCatalogLifecycleTemplate, downloadCatalogTemplate } from "../../shared/importTemplates";

type CatalogRowDraft = Omit<CatalogRow, "weight_kg"> & {
  weight_kg: number | string | null;
};

function parseWeightInput(value: number | string | null | undefined) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const normalized = text.replace(",", ".");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

export function CatalogPage() {
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [importBrand, setImportBrand] = useState("");
  const [importBrandName, setImportBrandName] = useState("");
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [exportBrand, setExportBrand] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showReferenceDialog, setShowReferenceDialog] = useState(false);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [catalogBrand, setCatalogBrand] = useState("");
  const [submittedCatalogBrand, setSubmittedCatalogBrand] = useState("");
  const [previewSelection, setPreviewSelection] = useState<{ brand: string; codes: string[] } | null>(null);
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CatalogRowDraft>>({});
  const [referenceCoverage, setReferenceCoverage] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [searchingCatalog, setSearchingCatalog] = useState(false);
  const [exportingCatalog, setExportingCatalog] = useState(false);
  const [rowActionKey, setRowActionKey] = useState("");
  const [importingCatalog, setImportingCatalog] = useState(false);
  const [syncingBrandCatalog, setSyncingBrandCatalog] = useState(false);
  const [creatingItem, setCreatingItem] = useState(false);
  const [savingReference, setSavingReference] = useState(false);
  const [referenceOldCodeUsage, setReferenceOldCodeUsage] = useState<CodeReferenceUsage | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; code: string; name: string } | null>(null);
  const [createDraft, setCreateDraft] = useState({
    product_code: "",
    brand: "",
    brand_name: "",
    description: "",
    oem_no: "",
    hs_code: "",
    origin: "",
    weight_kg: "",
    lifecycle_status: "active",
    lifecycle_note: "",
  });
  const [referenceDraft, setReferenceDraft] = useState({
    brand: "",
    old_code: "",
    new_code: "",
    original_number: "",
    reason: "",
  });
  const lifecycleOptions = [
    { value: "active", label: "Active" },
    { value: "discontinued", label: "Discontinued" },
  ];

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
      if (!submittedSearch.trim() && !submittedCatalogBrand) {
        if (!cancelled) {
          setRows([]);
          setLoading(false);
          setError("");
          setStatus("");
        }
        return;
      }

      setLoading(true);
      setError("");
      setStatus("");
      try {
        const result =
          previewSelection && !submittedSearch.trim() && submittedCatalogBrand === previewSelection.brand
            ? await fetchCatalogRowsByCodes({
                brandName: previewSelection.brand,
                codes: previewSelection.codes,
              })
            : await fetchCloudCatalog({
                search: submittedSearch,
                brandName: submittedCatalogBrand,
                page: 1,
                pageSize: 50,
              });
        if (!cancelled) setRows(result);
        if (!cancelled) setDrafts({});
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          setDrafts({});
          setError(caught instanceof Error ? caught.message : "Catalog request failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [submittedSearch, submittedCatalogBrand, previewSelection]);

  useEffect(() => {
    if (!searchingCatalog || loading) return;
    const nextTotal = rows[0]?.total_count ?? 0;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(`${nextTotal.toLocaleString("en-US")} catalog rows loaded.`);
    }
    setSearchingCatalog(false);
  }, [searchingCatalog, loading, error, rows, actionFeedback]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!rows.length) {
        setReferenceCoverage({});
        return;
      }

      try {
        const coverage = await fetchCatalogReferenceCoverage(
          rows.map((row) => ({
            brand: row.brand,
            product_code: row.product_code,
          })),
        );
        if (!cancelled) setReferenceCoverage(coverage);
      } catch {
        if (!cancelled) setReferenceCoverage({});
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [rows]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!showReferenceDialog || !referenceDraft.brand || !referenceDraft.old_code.trim()) {
        setReferenceOldCodeUsage(null);
        return;
      }

      try {
        const usage = await inspectCodeReferenceUsage({
          brand: referenceDraft.brand,
          code: referenceDraft.old_code,
        });
        if (!cancelled) setReferenceOldCodeUsage(usage);
      } catch {
        if (!cancelled) setReferenceOldCodeUsage(null);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [showReferenceDialog, referenceDraft.brand, referenceDraft.old_code]);

  const total = rows[0]?.total_count ?? 0;
  const originalNumberBrandMatches = useMemo(() => {
    if (!submittedSearch.trim() || !rows.length) return [];
    return Array.from(
      new Set(
        rows
          .filter((row) => matchesOriginalNumberSearch(row.oem_no || "", submittedSearch))
          .map((row) => String(row.brand || "").trim())
          .filter(Boolean),
      ),
    ).sort((left, right) => left.localeCompare(right));
  }, [rows, submittedSearch]);
  const brandOptions = [
    ...brands.map((item) => ({ value: item.name, label: item.name })),
    { value: "__new__", label: "New brand..." },
  ];
  const editableBrandOptions = brands.map((item) => ({ value: item.name, label: item.name }));
  const createBrandOptions = [
    ...editableBrandOptions,
    { value: "__new__", label: "New brand..." },
  ];

  function applyCatalogFilters(nextSearch: string, nextBrand: string, announce = true) {
    setSearchingCatalog(true);
    setPreviewSelection(null);
    if (announce) {
      actionFeedback.begin(`Searching catalog for ${nextBrand || "all brands"} / ${nextSearch.trim() || "all items"}...`);
    }
    setSubmittedSearch(nextSearch);
    setSubmittedCatalogBrand(nextBrand);
  }

  function renderReferenceOldCodeHint(usage: CodeReferenceUsage | null) {
    if (!usage) return null;
    if (usage.matchesOldCode.length) {
      const linked = usage.matchesOldCode[0];
      return (
        <div className="warning-text">
          This old customer code already has a mapping to <strong>{linked.new_code}</strong>.
        </div>
      );
    }
    if (usage.matchesNewCode.length) {
      const linked = usage.matchesNewCode[0];
      return (
        <div className="warning-text">
          This code is already used as a current valid code. Old code for it is <strong>{linked.old_code}</strong>.
        </div>
      );
    }
    return null;
  }

  const columns = useMemo(
    () => [
      {
        key: "image",
        header: "Image",
        render: (row: CatalogRow) =>
          row.image_url ? (
            <button
              type="button"
              className="catalog-thumb-button"
              onClick={() =>
                setPreviewImage({
                  src: row.image_url || "",
                  code: row.product_code,
                  name: row.description || "",
                })
              }
            >
              <img src={row.image_url} alt={row.product_code} className="catalog-thumb" loading="lazy" />
            </button>
          ) : (
            <span>-</span>
          ),
      },
      {
        key: "code",
        header: "Code",
        render: (row: CatalogRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.product_id]?.product_code ?? row.product_code}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), product_code: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "brand",
        header: "Brand",
        render: (row: CatalogRow) => (
          <select
            className="inline-edit-input"
            value={drafts[row.product_id]?.brand ?? row.brand}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), brand: event.target.value },
              }))
            }
          >
            {editableBrandOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ),
      },
      {
        key: "name",
        header: "Name",
        render: (row: CatalogRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.product_id]?.description ?? row.description ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), description: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "oem",
        header: "OEM",
        render: (row: CatalogRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.product_id]?.oem_no ?? row.oem_no ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), oem_no: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "hs",
        header: "HS",
        render: (row: CatalogRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.product_id]?.hs_code ?? row.hs_code ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), hs_code: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "origin",
        header: "Origin",
        render: (row: CatalogRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.product_id]?.origin ?? row.origin ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), origin: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "weight",
        header: "Weight",
        render: (row: CatalogRow) => (
          <input
            className="inline-edit-input"
            value={String(drafts[row.product_id]?.weight_kg ?? row.weight_kg ?? "")}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), weight_kg: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "lifecycle",
        header: "Lifecycle",
        render: (row: CatalogRow) => (
          <select
            className="inline-edit-input"
            value={drafts[row.product_id]?.lifecycle_status ?? row.lifecycle_status ?? "active"}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: {
                  ...(current[row.product_id] || row),
                  lifecycle_status: normalizeCatalogLifecycleStatus(event.target.value),
                },
              }))
            }
          >
            {lifecycleOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ),
      },
      {
        key: "lifecycleNote",
        header: "Lifecycle Note",
        render: (row: CatalogRow) => (
          <input
            className="inline-edit-input"
            value={drafts[row.product_id]?.lifecycle_note ?? row.lifecycle_note ?? ""}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [row.product_id]: { ...(current[row.product_id] || row), lifecycle_note: event.target.value },
              }))
            }
          />
        ),
      },
      {
        key: "ref",
        header: "Ref",
        render: (row: CatalogRow) => {
          const key = `${row.brand.trim().toLowerCase()}::${normalizePartCode(row.product_code)}`;
          const count = referenceCoverage[key] || 0;
          return <span className={count ? "status-badge status-badge--success" : "status-badge"}>{count ? `Mapped (${count})` : "-"}</span>;
        },
      },
      {
        key: "actions",
        header: "Actions",
        render: (row: CatalogRow) => (
          <div className="inline-actions">
            <Button
              variant="secondary"
              className="button--compact"
              onClick={async () => {
                const draft = drafts[row.product_id] || row;
                try {
                  setError("");
                  setStatus("");
                  setRowActionKey(`save:${row.product_id}`);
                  actionFeedback.begin(`Saving catalog row ${draft.product_code}...`);
                  await updateCloudCatalogRow(row.product_id, {
                    product_code: draft.product_code,
                    brand: draft.brand,
                    description: draft.description || null,
                    oem_no: draft.oem_no || null,
                    hs_code: draft.hs_code || null,
                    origin: draft.origin || null,
                    weight_kg: parseWeightInput(draft.weight_kg),
                    lifecycle_status: draft.lifecycle_status || "active",
                    lifecycle_note: draft.lifecycle_note || null,
                  });
                  await reloadCatalog(submittedSearch, submittedCatalogBrand);
                  setStatus(`Catalog row ${draft.product_code} saved.`);
                  actionFeedback.succeed(`Catalog row ${draft.product_code} saved.`);
                } catch (caught) {
                  const message = caught instanceof Error ? caught.message : "Catalog update failed";
                  setError(message);
                  actionFeedback.fail(message);
                } finally {
                  setRowActionKey("");
                }
              }}
              busy={rowActionKey === `save:${row.product_id}`}
              busyLabel="Saving..."
            >
              Save
            </Button>
            <Button
              variant="secondary"
              className="button--compact danger-button"
              onClick={async () => {
                if (!confirm(`Delete ${row.product_code} from catalog?`)) return;
                try {
                  setError("");
                  setStatus("");
                  setRowActionKey(`delete:${row.product_id}`);
                  actionFeedback.begin(`Deleting catalog row ${row.product_code}...`);
                  await deleteCloudCatalogRow(row.product_id);
                  await reloadCatalog(submittedSearch, submittedCatalogBrand);
                  setStatus(`Catalog row ${row.product_code} deleted.`);
                  actionFeedback.succeed(`Catalog row ${row.product_code} deleted.`);
                } catch (caught) {
                  const message = caught instanceof Error ? caught.message : "Catalog delete failed";
                  setError(message);
                  actionFeedback.fail(message);
                } finally {
                  setRowActionKey("");
                }
              }}
              busy={rowActionKey === `delete:${row.product_id}`}
              busyLabel="Deleting..."
            >
              Delete
            </Button>
            <Button
              variant="secondary"
              className="button--compact"
              onClick={() => {
                const coverageKey = `${row.brand.trim().toLowerCase()}::${normalizePartCode(row.product_code)}`;
                const hasReference = (referenceCoverage[coverageKey] || 0) > 0;
                const draft = drafts[row.product_id] || row;
                setReferenceDraft({
                  brand: draft.brand || row.brand || "",
                  old_code: "",
                  new_code: draft.product_code || row.product_code || "",
                  original_number: draft.oem_no || row.oem_no || "",
                  reason: hasReference ? "Update existing replacement mapping" : "Supplier changed / replacement code",
                });
                setError("");
                setStatus("");
                setShowReferenceDialog(true);
              }}
            >
              {(() => {
                const coverageKey = `${row.brand.trim().toLowerCase()}::${normalizePartCode(row.product_code)}`;
                return (referenceCoverage[coverageKey] || 0) > 0 ? "Edit Ref" : "Add Ref";
              })()}
            </Button>
          </div>
        ),
      },
    ],
    [drafts, editableBrandOptions, referenceCoverage, rowActionKey, submittedSearch, submittedCatalogBrand],
  );

  async function reloadCatalog(nextSearch = submittedSearch, nextBrand = submittedCatalogBrand) {
    setLoading(true);
    setError("");
    setStatus("");
    try {
      const result = await fetchCloudCatalog({
        search: nextSearch,
        brandName: nextBrand,
        page: 1,
        pageSize: 50,
      });
      setRows(result);
    } catch (caught) {
      setRows([]);
      setError(caught instanceof Error ? caught.message : "Catalog request failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleCatalogImport(file: File) {
    setLoading(true);
    setError("");
    setStatus("");
    setImportingCatalog(true);
    try {
      const text = await file.text();
      const parsedRows = parseCsv(text);
      const [header = [], ...dataRows] = parsedRows;
      const indexOfAny = (...names: string[]) =>
        header.findIndex((cell) => {
          const value = cell.trim().toLowerCase();
          return names.some((name) => value === name.toLowerCase());
        });

      const codeIndex = indexOfAny("Product_Code", "Part_No", "Code");
      const brandIndex = indexOfAny("Brand");
      const nameIndex = indexOfAny("Product_Name", "Name", "Description");
      const oemIndex = indexOfAny("OEM_No", "OEM", "Original_Number");
      const hsIndex = indexOfAny("HS_Code", "HS", "GTIP");
      const originIndex = indexOfAny("Origin", "Country_Of_Origin");
      const weightIndex = indexOfAny("Weight_kg", "Weight", "Net_Weight");
      const imageUrlIndex = indexOfAny("Image_URL", "Image Url", "Image");
      const lifecycleStatusIndex = indexOfAny("Lifecycle_Status", "Lifecycle");
      const lifecycleNoteIndex = indexOfAny("Lifecycle_Note", "Lifecycle Note", "Discontinued_Note", "Discontinued Note");
      const selectedImportBrand = importBrand === "__new__" ? importBrandName.trim() : importBrand.trim();
      const rowBrands = dataRows.map((row) => normalizeText(row[brandIndex]) ?? "");
      const detectedBrands = Array.from(
        new Set(
          rowBrands
            .filter((value) => value.length > 0)
            .map((value) => value.toLowerCase()),
        ),
      );
      const activeImportBrand =
        selectedImportBrand ||
        (detectedBrands.length === 1
          ? rowBrands.find((value) => value.length > 0) || ""
          : "");

      if (!activeImportBrand) {
        throw new Error("Catalog import requires a single brand selection or a single brand in the file");
      }

      actionFeedback.begin(`Importing catalog CSV for ${activeImportBrand}...`);

      const payload = dataRows
        .map((row) => ({
          product_code: normalizeText(row[codeIndex]),
          brand: normalizeText(row[brandIndex]) || activeImportBrand || "Unbranded",
          description: normalizeText(row[nameIndex]),
          oem_no: normalizeText(row[oemIndex]),
          hs_code: normalizeText(row[hsIndex]),
          origin: normalizeText(row[originIndex]),
          weight_kg: normalizeNumber(row[weightIndex]),
          image_url: normalizeText(row[imageUrlIndex]),
          lifecycle_status: normalizeCatalogLifecycleStatus(normalizeText(row[lifecycleStatusIndex])),
          lifecycle_note: normalizeText(row[lifecycleNoteIndex]),
        }))
        .filter((row) => row.product_code);

      if (!payload.length) {
        throw new Error("CSV did not contain any valid catalog rows");
      }

      const importedCodes = Array.from(
        new Set(
          payload
            .map((row) => row.product_code ?? "")
            .filter((code) => code.length > 0),
        ),
      );

      await bulkImportCatalog(payload);
      const refreshedBrands = await fetchCloudBrands();
      setBrands(refreshedBrands);
      const matchedBrand = refreshedBrands.find((item) => item.name.trim().toLowerCase() === activeImportBrand.trim().toLowerCase());
      const refreshedBrandName = matchedBrand?.name ?? activeImportBrand;
      if (matchedBrand) {
        setImportBrand(matchedBrand.name);
        setImportBrandName(matchedBrand.name);
      } else {
        setImportBrand(activeImportBrand);
        setImportBrandName(activeImportBrand);
      }
      setPreviewSelection({
        brand: refreshedBrandName,
        codes: importedCodes,
      });
      setCatalogBrand(refreshedBrandName);
      setSubmittedCatalogBrand(refreshedBrandName);
      setSearch("");
      setSubmittedSearch("");
      setExportBrand(refreshedBrandName);
      const importedRows = await fetchCatalogRowsByCodes({
        brandName: refreshedBrandName,
        codes: importedCodes,
      });
      setRows(importedRows);
      setDrafts({});
      setShowImportDialog(false);
      setImportFile(null);
      setStatus(`Catalog import completed for ${activeImportBrand}. Showing imported codes for review.`);
      actionFeedback.succeed(`Catalog import completed for ${activeImportBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Catalog import failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setLoading(false);
      setImportingCatalog(false);
    }
  }

  async function handleCatalogExport() {
    if (!exportBrand) {
      setError("Catalog export requires a brand selection");
      return;
    }

    setExportingCatalog(true);
    setError("");
    setStatus("");
    actionFeedback.begin(`Preparing catalog CSV export for ${exportBrand}...`);

    try {
      const exportData = await fetchCatalogExportRows({ brandName: exportBrand });
      const exportRows = [
        ["Product_Code", "Brand", "Product_Name", "OEM_No", "HS_Code", "Origin", "Weight_kg", "Image_URL", "Lifecycle_Status", "Lifecycle_Note"],
        ...exportData.map((row) => [
          row.product_code,
          row.brand,
          row.description || "",
          row.oem_no || "",
          row.hs_code || "",
          row.origin || "",
          row.weight_kg ?? "",
          row.image_url || "",
          row.lifecycle_status || "active",
          row.lifecycle_note || "",
        ]),
      ];
      downloadCsv(`catalog-${exportBrand.toLowerCase().replace(/\s+/g, "-")}.csv`, toCsv(exportRows));
      setShowExportDialog(false);
      setStatus(`Catalog CSV downloaded for ${exportBrand}.`);
      actionFeedback.succeed(`Catalog CSV downloaded for ${exportBrand}.`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Catalog export failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setExportingCatalog(false);
    }
  }

  async function handleSyncSelectedBrandFromSpareto() {
    if (!catalogBrand.trim()) {
      const message = "Select a brand first.";
      setError(message);
      actionFeedback.fail(message);
      return;
    }

    setSyncingBrandCatalog(true);
    setError("");
    setStatus("");
    actionFeedback.begin(`Syncing ${catalogBrand} from Spareto...`);

    try {
      const result = await syncBrandCatalogFromSpareto(catalogBrand, true);
      setStatus(
        `${result.targetBrandName}: ${result.resolvedRows.toLocaleString("en-US")} synced, ${result.newRowsInListing.toLocaleString("en-US")} new, ${result.errorRows.toLocaleString("en-US")} errors.`,
      );
      actionFeedback.succeed(`${result.targetBrandName}: ${result.resolvedRows.toLocaleString("en-US")} catalog rows synced.`);
      applyCatalogFilters(search, catalogBrand, false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Brand catalog sync failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setSyncingBrandCatalog(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="section-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>Catalog</h2>
            <p>Connected to live Supabase catalog data.</p>
          </div>
          <div className="toolbar">
            <Select
              value={catalogBrand}
              options={[{ value: "", label: "All Brands" }, ...editableBrandOptions]}
              onChange={(value) => {
                setCatalogBrand(value);
                if (value) {
                  applyCatalogFilters(search, value);
                  return;
                }
                if (!search.trim()) {
                  setSubmittedCatalogBrand("");
                  setSubmittedSearch("");
                  setRows([]);
                  setStatus("");
                  setError("");
                }
              }}
            />
            <Input value={search} onChange={setSearch} placeholder="Search catalog" onEnter={() => applyCatalogFilters(search, catalogBrand)} />
            <Button
              onClick={() => {
                applyCatalogFilters(search, catalogBrand);
              }}
              busy={searchingCatalog}
              busyLabel="Searching..."
            >
              Search
            </Button>
            <Button variant="secondary" onClick={() => setShowExportDialog(true)} disabled={!brands.length} busy={exportingCatalog} busyLabel="Preparing...">
              Export CSV
            </Button>
            <Button variant="secondary" onClick={() => setShowCreateDialog(true)}>
              Add New Item
            </Button>
            <Button variant="secondary" onClick={() => setShowImportDialog(true)}>
              Import CSV
            </Button>
            {catalogBrand ? (
              <Button variant="secondary" onClick={() => void handleSyncSelectedBrandFromSpareto()} busy={syncingBrandCatalog} busyLabel="Syncing...">
                Re-sync from Spareto
              </Button>
            ) : null}
          </div>
        </div>
        <div className="section-card__body">
          <div className="meta-row">
            <span>
              {loading
                ? "Loading catalog..."
                : !submittedSearch.trim() && !submittedCatalogBrand
                  ? "Select a brand or search to load catalog."
                  : `${total.toLocaleString("en-US")} catalog rows`}
            </span>
            {originalNumberBrandMatches.length ? (
              <span>
                Original No Brands: <strong>{originalNumberBrandMatches.join(", ")}</strong>
              </span>
            ) : null}
            {status ? <span className="success-text">{status}</span> : null}
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable
            rows={rows}
            columns={columns}
            emptyText={loading ? "Loading..." : !submittedSearch.trim() && !submittedCatalogBrand ? "Select a brand or search to load catalog." : "No products found"}
          />
        </div>
      </section>

      {showImportDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-card__header">
              <div>
                <h3>Catalog CSV Import</h3>
                <p>Fill all required fields before starting the import.</p>
              </div>
            </div>
            <div className="modal-form-grid">
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
              <Input label="Target" value="Cloud catalog import" onChange={() => undefined} disabled />
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
            <div className="modal-hint">Brand, target, and file are required for every catalog CSV import. For discontinued/EOL updates, use the lifecycle template instead of full export.</div>
            <div className="toolbar">
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadCatalogTemplate();
                  actionFeedback.succeed("Catalog sample template downloaded.");
                }}
              >
                Download Sample Template
              </Button>
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => {
                  downloadCatalogLifecycleTemplate();
                  actionFeedback.succeed("Catalog lifecycle template downloaded.");
                }}
              >
                Download Lifecycle Template
              </Button>
            </div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowImportDialog(false);
                  setImportFile(null);
                  setImportBrand("");
                  setImportBrandName("");
                }}
              >
                Cancel Import
              </Button>
              <Button
                onClick={() => {
                  if (importFile) void handleCatalogImport(importFile);
                }}
                disabled={!importFile || loading || (importBrand === "__new__" && !importBrandName.trim())}
                busy={importingCatalog}
                busyLabel="Importing..."
              >
                Import
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showExportDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-card__header">
              <div>
                <h3>Catalog CSV Export</h3>
                <p>Select a brand to download its full catalog list.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select label="Brand" value={exportBrand} options={editableBrandOptions} onChange={setExportBrand} />
              <Input label="Scope" value="All items for selected brand" onChange={() => undefined} disabled />
            </div>
          <div className="modal-hint">This export ignores the current search box and downloads the full catalog of the selected brand.</div>
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowExportDialog(false);
                  setExportBrand("");
                }}
              >
                Cancel
              </Button>
              <Button onClick={() => void handleCatalogExport()} disabled={!exportBrand} busy={exportingCatalog} busyLabel="Preparing...">
                Export CSV
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showCreateDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-card__header">
              <div>
                <h3>Add New Item</h3>
                <p>Create a new catalog product under Items.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Input label="Product Code" value={createDraft.product_code} onChange={(value) => setCreateDraft((current) => ({ ...current, product_code: value }))} />
              <Select
                label="Brand"
                value={createDraft.brand}
                options={createBrandOptions}
                onChange={(value) =>
                  setCreateDraft((current) => ({
                    ...current,
                    brand: value,
                    brand_name: value === "__new__" ? "" : value,
                  }))
                }
              />
              <Input
                label="Brand Name"
                value={createDraft.brand_name}
                onChange={(value) => setCreateDraft((current) => ({ ...current, brand_name: value }))}
                disabled={createDraft.brand !== "__new__"}
              />
              <Input label="Product Name" value={createDraft.description} onChange={(value) => setCreateDraft((current) => ({ ...current, description: value }))} />
              <Input label="OEM" value={createDraft.oem_no} onChange={(value) => setCreateDraft((current) => ({ ...current, oem_no: value }))} />
              <Input label="HS Code" value={createDraft.hs_code} onChange={(value) => setCreateDraft((current) => ({ ...current, hs_code: value }))} />
              <Input label="Origin" value={createDraft.origin} onChange={(value) => setCreateDraft((current) => ({ ...current, origin: value }))} />
              <Input label="Weight" value={createDraft.weight_kg} onChange={(value) => setCreateDraft((current) => ({ ...current, weight_kg: value }))} />
              <Select
                label="Lifecycle"
                value={createDraft.lifecycle_status}
                options={lifecycleOptions}
                onChange={(value) => setCreateDraft((current) => ({ ...current, lifecycle_status: value }))}
              />
              <Input label="Lifecycle Note" value={createDraft.lifecycle_note} onChange={(value) => setCreateDraft((current) => ({ ...current, lifecycle_note: value }))} />
            </div>
            <div className="modal-hint">Product code and brand are required. The item will be created directly in cloud catalog.</div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    setError("");
                    setStatus("");
                    setCreatingItem(true);
                    actionFeedback.begin(`Creating item ${createDraft.product_code.trim()}...`);
                    const activeBrand = createDraft.brand === "__new__" ? createDraft.brand_name.trim() : createDraft.brand;
                    await createCloudCatalogRow({
                      product_code: createDraft.product_code.trim(),
                      brand: activeBrand,
                      description: createDraft.description.trim() || null,
                      oem_no: createDraft.oem_no.trim() || null,
                      hs_code: createDraft.hs_code.trim() || null,
                      origin: createDraft.origin.trim() || null,
                      weight_kg: parseWeightInput(createDraft.weight_kg),
                      lifecycle_status: createDraft.lifecycle_status,
                      lifecycle_note: createDraft.lifecycle_note.trim() || null,
                    });
                    setCreateDraft({
                      product_code: "",
                      brand: "",
                      brand_name: "",
                      description: "",
                      oem_no: "",
                      hs_code: "",
                      origin: "",
                      weight_kg: "",
                      lifecycle_status: "active",
                      lifecycle_note: "",
                    });
                    const refreshedBrands = await fetchCloudBrands();
                    setBrands(refreshedBrands);
                    setShowCreateDialog(false);
                    await reloadCatalog(submittedSearch, submittedCatalogBrand);
                    setStatus("Catalog item created successfully.");
                    actionFeedback.succeed(`Catalog item ${createDraft.product_code.trim()} created.`);
                  } catch (caught) {
                    const message = caught instanceof Error ? caught.message : "Catalog create failed";
                    setError(message);
                    actionFeedback.fail(message);
                  } finally {
                    setCreatingItem(false);
                  }
                }}
                disabled={
                  !createDraft.product_code.trim() ||
                  !createDraft.brand ||
                  (createDraft.brand === "__new__" && !createDraft.brand_name.trim())
                }
                busy={creatingItem}
                busyLabel="Creating..."
              >
                Create Item
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {showReferenceDialog ? (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="modal-card__header">
              <div>
                <h3>Add Code Reference</h3>
                <p>Create a mapping from the customer's old code to this current valid catalog code.</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <Select
                label="Brand"
                value={referenceDraft.brand}
                options={editableBrandOptions}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, brand: value }))}
              />
              <Input
                label="Old Code"
                value={referenceDraft.old_code}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, old_code: value }))}
              />
              <Input label="New Code" value={referenceDraft.new_code} onChange={() => undefined} disabled />
              <Input
                label="Original Number"
                value={referenceDraft.original_number}
                onChange={(value) => setReferenceDraft((current) => ({ ...current, original_number: value }))}
              />
              <Input label="Reason" value={referenceDraft.reason} onChange={(value) => setReferenceDraft((current) => ({ ...current, reason: value }))} />
            </div>
            {renderReferenceOldCodeHint(referenceOldCodeUsage)}
            <div className="modal-hint">Old Code = the obsolete number still asked by customers. New Code = the current active catalog number.</div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setShowReferenceDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  try {
                    setError("");
                    setStatus("");
                    setSavingReference(true);
                    actionFeedback.begin(`Saving code reference for ${referenceDraft.old_code.trim()}...`);
                    await createCodeReference({
                      brand: referenceDraft.brand,
                      old_code: referenceDraft.old_code.trim(),
                      new_code: referenceDraft.new_code.trim(),
                      original_number: referenceDraft.original_number.trim() || null,
                      reason: referenceDraft.reason.trim() || null,
                    });
                    setReferenceCoverage((current) => {
                      const key = `${referenceDraft.brand.trim().toLowerCase()}::${normalizePartCode(referenceDraft.new_code)}`;
                      return {
                        ...current,
                        [key]: (current[key] || 0) + 1,
                      };
                    });
                    setStatus(
                      `Code reference saved. Quotes will warn for old code ${referenceDraft.old_code.trim()} and use ${referenceDraft.new_code.trim()}.`,
                    );
                    setShowReferenceDialog(false);
                    actionFeedback.succeed(`Code reference saved for old code ${referenceDraft.old_code.trim()}.`);
                  } catch (caught) {
                    const message = caught instanceof Error ? caught.message : "Code reference create failed";
                    if (message.includes("item_code_references_organization_id_brand_id_normalized_ol_key")) {
                      setError("This old customer code already has a mapping for this brand. Use the existing reference instead of creating a duplicate.");
                    } else {
                      setError(message);
                    }
                    actionFeedback.fail(message);
                  } finally {
                    setSavingReference(false);
                  }
                }}
                disabled={!referenceDraft.brand || !referenceDraft.old_code.trim() || !referenceDraft.new_code.trim()}
                busy={savingReference}
                busyLabel="Saving..."
              >
                Save Reference
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {previewImage ? (
        <div className="modal-backdrop" onClick={() => setPreviewImage(null)}>
          <div className="modal-card modal-card--image-preview" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card__header">
              <div>
                <h3>{previewImage.code}</h3>
                <p>{previewImage.name || "Catalog image preview"}</p>
              </div>
            </div>
            <div className="image-preview-wrap">
              <img src={previewImage.src} alt={previewImage.code} className="image-preview" />
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setPreviewImage(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
