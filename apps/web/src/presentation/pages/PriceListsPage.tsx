import { useEffect, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchCustomerPriceListExportRows, fetchPriceListSettings, updateMarginPriceList } from "../../infrastructure/api/priceListsApi";
import type { BrandOption } from "../../types/brand";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { useI18n } from "../../i18n/I18nProvider";

export function PriceListsPage() {
  const { t } = useI18n();
  const actionFeedback = useActionFeedback();
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"success" | "error" | null>(null);
  const [marginA, setMarginA] = useState("10");
  const [marginB, setMarginB] = useState("15");
  const [savingMargins, setSavingMargins] = useState(false);
  const [downloadBrandId, setDownloadBrandId] = useState("");
  const [downloadListType, setDownloadListType] = useState<"A" | "B">("A");
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

  const downloadListOptions = [
    { value: "A", label: t("sales.priceLists.aPriceList") },
    { value: "B", label: t("sales.priceLists.bPriceList") },
  ];
  const selectedDownloadBrand = brands.find((item) => item.id === downloadBrandId) || null;
  const downloadBrandOptions = [
    { value: "", label: brands.length ? t("sales.priceLists.selectBrand") : t("sales.priceLists.noBrandsAvailable") },
    ...brands.map((item) => ({ value: item.id, label: item.name })),
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

  async function handleDownloadPriceList() {
    const brandName = String(selectedDownloadBrand?.name || "").trim();
    if (!selectedDownloadBrand?.id || !brandName) {
      setStatus(t("sales.priceLists.selectBrandBeforeDownload"));
      setStatusTone("error");
      return;
    }

    try {
      setStatus("");
      setStatusTone(null);
      setDownloadingPriceList(true);
      actionFeedback.begin(t("sales.priceLists.preparingDownload", { listType: downloadListType, brandName }));
      const marginPercent = downloadListType === "A" ? Number(marginA) / 100 : Number(marginB) / 100;
      const catalogRows = await fetchCustomerPriceListExportRows({
        brandId: selectedDownloadBrand.id,
        priceListType: downloadListType,
        marginPercent,
        pageSize: 1000,
      });
      const sheetRows: Array<Array<string | number | null>> = [["New_Code", "Old_Codes", "Brand", "Product_Name", "OEM_No", "HS_Code", "Origin", "Weight_kg", "Price_List_Type", "Sales_Price_EUR", "Notes"]];

      sheetRows.push(
        ...catalogRows.map((row) => [
          row.product_code,
          "",
          row.brand || brandName,
          row.description || "",
          row.oem_no || "",
          row.hs_code || "",
          row.origin || "",
          row.weight_kg ?? "",
          `${row.price_list_type || downloadListType} Price List`,
          row.sales_price ?? "",
          row.notes || "",
        ]),
      );

      const blob = buildXlsxBlob(`${brandName} ${downloadListType}`, sheetRows, [8, 10, 13]);
      downloadBlob(`price-list-${brandName.toLowerCase().replace(/\s+/g, "-")}-${downloadListType.toLowerCase()}.xlsx`, blob);
      setStatus(t("sales.priceLists.downloaded", { listType: downloadListType, brandName }));
      setStatusTone("success");
      actionFeedback.succeed(t("sales.priceLists.downloaded", { listType: downloadListType, brandName }));
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
      </div>
      <div className="settings-grid">
        <div className="settings-item">
          <span className="settings-label">{t("sales.priceLists.downloadBrand")}</span>
          <Select value={downloadBrandId} options={downloadBrandOptions} onChange={setDownloadBrandId} />
        </div>
        <div className="settings-item">
          <span className="settings-label">{t("sales.priceLists.priceListType")}</span>
          <Select value={downloadListType} options={downloadListOptions} onChange={(value) => setDownloadListType(value as "A" | "B")} />
        </div>
      </div>
      <div className="toolbar toolbar--wrap">
        <Button variant="secondary" onClick={() => void handleDownloadPriceList()} disabled={!downloadBrandId} busy={downloadingPriceList} busyLabel={t("sales.priceLists.preparing")}>
          {t("sales.priceLists.downloadPriceList")}
        </Button>
      </div>
      {status ? <div className={statusTone === "success" ? "success-text" : "error-text"}>{status}</div> : null}
    </SectionCard>
  );
}
