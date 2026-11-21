import { parseManualMarginPercent, type AdminPriceListType } from "../../../../../shared/admin-price-list-margin.mjs";
import { useEffect, useState } from "react";
import { fetchCloudPriceListBrands } from "../../infrastructure/api/brandsApi";
import { fetchPriceListSettings, updateMarginPriceList } from "../../infrastructure/api/priceListsApi";
import { downloadExportJob, startAdminPriceListExport, waitForExportJob } from "../../infrastructure/api/exportJobsApi";
import type { BrandOption } from "../../types/brand";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";
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
  const [downloadListType, setDownloadListType] = useState<AdminPriceListType>("A");
  const [manualMargin, setManualMargin] = useState("");
  const [downloadingPriceList, setDownloadingPriceList] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [settings, brandRows] = await Promise.all([fetchPriceListSettings(), fetchCloudPriceListBrands()]);
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
    { value: "Manual", label: t("sales.priceLists.manualPriceList") },
  ];
  const manualRate = parseManualMarginPercent(manualMargin);
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
    const marginPercent = downloadListType === "Manual"
      ? manualRate
      : Number(downloadListType === "A" ? marginA : marginB) / 100;
    if (marginPercent === null || !Number.isFinite(marginPercent)) {
      setStatus(t(downloadListType === "Manual" ? "sales.priceLists.invalidManualMargin" : "sales.priceLists.marginsMustBeNumeric"));
      setStatusTone("error");
      return;
    }

    const listLabel = downloadListType === "Manual" ? t("sales.priceLists.manualListLabel") : downloadListType;
    try {
      setStatus("");
      setStatusTone(null);
      setDownloadingPriceList(true);
      actionFeedback.begin(t("sales.priceLists.preparingDownload", { listType: listLabel, brandName }));
      const initialJob = await startAdminPriceListExport({
        brandId: selectedDownloadBrand.id,
        brandName,
        priceListType: downloadListType,
        marginPercent,
      });
      const readyJob = await waitForExportJob(initialJob, (job) => {
        const progress = job.progressTotal
          ? ` ${job.progressDone.toLocaleString("en-US")} / ${job.progressTotal.toLocaleString("en-US")}`
          : job.progressDone ? ` ${job.progressDone.toLocaleString("en-US")}` : "";
        setStatus(`${t("sales.priceLists.preparingDownload", { listType: listLabel, brandName })}${progress}`);
      });
      await downloadExportJob(readyJob.id);
      const downloadedMessage = t("sales.priceLists.downloaded", { listType: listLabel, brandName });
      setStatus(downloadedMessage);
      setStatusTone("success");
      actionFeedback.succeed(downloadedMessage);
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
      <p className="muted-text">{t("sales.priceLists.downloadEligibilityHint")}</p>
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
          <Select value={downloadListType} options={downloadListOptions} onChange={(value) => setDownloadListType(value as AdminPriceListType)} />
        </div>
        {downloadListType === "Manual" && (
          <div className="settings-item">
            <label className="field">
              <span className="settings-label">{t("sales.priceLists.manualMarginLabel")}</span>
              <input
                className="field__input"
                inputMode="decimal"
                value={manualMargin}
                onChange={(event) => setManualMargin(event.target.value)}
                placeholder={t("sales.priceLists.manualMarginPlaceholder")}
                aria-describedby="manual-margin-hint"
                aria-invalid={Boolean(manualMargin && manualRate === null)}
              />
            </label>
            <span className="muted-text" id="manual-margin-hint">
              {t(manualMargin && manualRate === null ? "sales.priceLists.invalidManualMargin" : "sales.priceLists.manualMarginHint")}
            </span>
          </div>
        )}
      </div>
      <div className="toolbar toolbar--wrap">
        <Button variant="secondary" onClick={() => void handleDownloadPriceList()} disabled={!downloadBrandId || (downloadListType === "Manual" && manualRate === null)} busy={downloadingPriceList} busyLabel={t("sales.priceLists.preparing")}>
          {t("sales.priceLists.downloadPriceList")}
        </Button>
      </div>
      {status ? <div className={statusTone === "success" ? "success-text" : statusTone === "error" ? "error-text" : undefined}>{status}</div> : null}
    </SectionCard>
  );
}
