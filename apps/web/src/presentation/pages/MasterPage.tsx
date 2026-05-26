import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCPriceMapForRows, getCPriceForRow } from "../../infrastructure/api/cPriceApi";
import { fetchAllCloudMaster, fetchCloudMaster } from "../../infrastructure/api/masterApi";
import { fetchPriceListSettings } from "../../infrastructure/api/priceListsApi";
import type { BrandOption } from "../../types/brand";
import type { MasterRow } from "../../types/master";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";

const scopeOptions = [
  { value: "catalog", label: "Catalog only" },
  { value: "all", label: "Catalog + supplier only" },
];

export function MasterPage() {
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [brand, setBrand] = useState("");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [scope, setScope] = useState("catalog");
  const [marginA, setMarginA] = useState(0.1);
  const [marginB, setMarginB] = useState(0.15);
  const [rows, setRows] = useState<MasterRow[]>([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [exportingMaster, setExportingMaster] = useState(false);

  function applyCPrices(baseRows: MasterRow[], priceMap: Map<string, number>) {
    return baseRows.map((row) => ({
      ...row,
      sales_c: getCPriceForRow(priceMap, row),
    }));
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoadingBrands(true);
      setError("");
      try {
        const result = await fetchCloudBrands();
        if (cancelled) return;
        setBrands(result);
        setBrand((current) => current || result[0]?.name || "");
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Brand request failed");
        }
      } finally {
        if (!cancelled) setLoadingBrands(false);
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
      try {
        const settings = await fetchPriceListSettings();
        if (cancelled) return;
        const a = settings.find((item) => item.listType === "A");
        const b = settings.find((item) => item.listType === "B");
        if (typeof a?.marginPercent === "number") setMarginA(a.marginPercent / 100);
        if (typeof b?.marginPercent === "number") setMarginB(b.marginPercent / 100);
      } catch {
        if (!cancelled) {
          setMarginA(0.1);
          setMarginB(0.15);
        }
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
      if (!brand) {
        setRows([]);
        return;
      }

      setLoadingRows(true);
      setError("");
      try {
        const result = await fetchCloudMaster({
          search: submittedSearch,
          brand,
          scope,
          page: 1,
          pageSize: 50,
          marginA,
          marginB,
        });
        const cPriceMap = await fetchCPriceMapForRows(result);
        if (!cancelled) setRows(applyCPrices(result, cPriceMap));
      } catch (caught) {
        if (!cancelled) {
          setRows([]);
          setError(caught instanceof Error ? caught.message : "Master request failed");
        }
      } finally {
        if (!cancelled) setLoadingRows(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [brand, scope, submittedSearch, marginA, marginB]);

  useEffect(() => {
    if (!searching || loadingRows) return;
    const nextTotal = rows[0]?.total_count ?? 0;
    if (error) {
      actionFeedback.fail(error);
    } else {
      actionFeedback.succeed(`${nextTotal.toLocaleString("en-US")} master rows loaded.`);
    }
    setSearching(false);
  }, [searching, loadingRows, error, rows, actionFeedback]);

  const total = rows[0]?.total_count ?? 0;

  const brandOptions = [
    { value: "", label: "Select brand" },
    ...brands.map((item) => ({ value: item.name, label: item.name })),
  ];

  const columns = useMemo(
    () => [
      { key: "code", header: "Code", render: (row: MasterRow) => row.product_code },
      { key: "brand", header: "Brand", render: (row: MasterRow) => row.brand || "-" },
      { key: "name", header: "Name", render: (row: MasterRow) => row.description || "-" },
      { key: "hs", header: "HS", render: (row: MasterRow) => row.hs_code || "-" },
      { key: "origin", header: "Origin", render: (row: MasterRow) => row.origin || "-" },
      { key: "weight", header: "Weight", render: (row: MasterRow) => row.weight_kg ?? "-" },
      { key: "supplier", header: "Cheapest Supplier", render: (row: MasterRow) => row.cheapest_supplier || "-" },
      { key: "price", header: "Cheapest", render: (row: MasterRow) => row.cheapest_price ?? "-" },
      { key: "salesA", header: "A Sales", render: (row: MasterRow) => row.sales_a ?? "-" },
      { key: "salesB", header: "B Sales", render: (row: MasterRow) => row.sales_b ?? "-" },
      { key: "salesC", header: "C Sales", render: (row: MasterRow) => row.sales_c ?? "-" },
      { key: "status", header: "Status", render: (row: MasterRow) => row.catalog_status || "-" },
    ],
    [],
  );

  async function loadMasterExportRows() {
    if (!brand) {
      throw new Error("Select a brand first.");
    }
    const exportRows = await fetchAllCloudMaster({
      search: submittedSearch,
      brand,
      scope,
      marginA,
      marginB,
    });
    const cPriceMap = await fetchCPriceMapForRows(exportRows);
    return applyCPrices(exportRows, cPriceMap);
  }

  async function handleMasterExport() {
    try {
      setError("");
      setExportingMaster(true);
      actionFeedback.begin("Preparing master export...");
      const exportRows = await loadMasterExportRows();
      if (!exportRows.length) {
        setError("No master rows found for the current filters.");
        actionFeedback.fail("No master rows found for the current filters.");
        return;
      }

      const headers = [
        "Product_Code",
        "Brand",
        "Product_Name",
        "OEM_No",
        "HS_Code",
        "Origin",
        "Weight_kg",
        "Cheapest_Supplier",
        "Cheapest_EUR",
        "Price_Date",
        "A_Sales_EUR",
        "B_Sales_EUR",
        "C_Sales_EUR",
        "Supplier_Count",
        "Catalog_Status",
        "Notes",
      ];
      const rowsForSheet = [
        headers,
        ...exportRows.map((row) => [
          row.product_code,
          row.brand || "",
          row.description || "",
          row.oem_no || "",
          row.hs_code || "",
          row.origin || "",
          row.weight_kg ?? "",
          row.cheapest_supplier || "",
          row.cheapest_price ?? "",
          row.price_date || "",
          row.sales_a ?? "",
          row.sales_b ?? "",
          row.sales_c ?? "",
          row.supplier_count ?? "",
          row.catalog_status || "",
          row.notes || "",
        ]),
      ];
      const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
      const fileBrand = (brand || "all-brands").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      downloadBlob(
        `${fileBrand}-${stamp}-master.xlsx`,
        buildXlsxBlob(`${brand || "All"} Master`, rowsForSheet, [6, 8, 10, 11, 12, 13]),
      );
      actionFeedback.succeed("Master export downloaded.");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Master export failed";
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setExportingMaster(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="section-card">
        <div className="section-card__header section-card__header--row">
          <div>
            <h2>Master</h2>
            <p>Live comparison view driven by supplier prices and catalog enrichment.</p>
          </div>
          <div className="toolbar toolbar--wrap">
            <Select label="Brand" value={brand} options={brandOptions} onChange={setBrand} />
            <Input
              label="Search"
              value={search}
              onChange={setSearch}
              placeholder="Code, OEM, name"
              onEnter={() => {
                setSearching(true);
                actionFeedback.begin(`Searching master for ${search.trim() || brand || "all items"}...`);
                setSubmittedSearch(search);
              }}
            />
            <Select label="Scope" value={scope} options={scopeOptions} onChange={setScope} />
            <Button
              onClick={() => {
                setSearching(true);
                actionFeedback.begin(`Searching master for ${search.trim() || brand || "all items"}...`);
                setSubmittedSearch(search);
              }}
              busy={searching}
              busyLabel="Searching..."
            >
              Search
            </Button>
            <Button
              variant="secondary"
              className="button--compact"
              onClick={() => void handleMasterExport()}
              busy={exportingMaster}
              busyLabel="Preparing..."
            >
              Master XLSX
            </Button>
          </div>
        </div>
        <div className="section-card__body">
          <div className="meta-row">
            <span>
              {!brand
                ? "Select a brand to load master."
                : loadingBrands
                ? "Loading brands..."
                : loadingRows
                  ? "Loading master rows..."
                  : `${total.toLocaleString("en-US")} master rows`}
            </span>
            {error ? <span className="error-text">{error}</span> : null}
          </div>
          <DataTable rows={rows} columns={columns} emptyText={!brand ? "Select a brand to load master." : loadingRows ? "Loading..." : "No master rows found"} />
        </div>
      </section>
    </div>
  );
}
