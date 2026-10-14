import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import {
  fetchCloudSupplierOperationsStatusAll,
  fetchCloudSuppliers,
  queueSupplierPriceCatalogSync,
  queueSupplierPriceRollupRefresh,
  retrySupplierPriceImportFinalize,
} from "../../infrastructure/api/suppliersApi";
import type { SupplierOperationsStatusRow, SupplierSummary } from "../../types/suppliers";
import { fetchCatalogIntegritySummary, fetchCatalogOperationsBrandStatus } from "../../infrastructure/api/catalogApi";
import type { CatalogIntegritySummary, CatalogOperationsBrandStatus } from "../../types/catalog";
import { downloadCsv, toCsv } from "../../shared/csv";
import { includesLooseText } from "../../domain/shared/normalize";
import { getOperationDefinition, isRegisteredOperation } from "../../shared/operationsRegistry";
import { isImportFailedStatus, mapImportStatusToTone, type ImportEngineStatus } from "../../shared/importEngine";
import { Button } from "../../presentation/components/common/Button";
import { BrandPill } from "../../presentation/components/common/BrandPill";
import { Input } from "../../presentation/components/common/Input";
import { SectionCard } from "../../presentation/components/common/SectionCard";
import { Select } from "../../presentation/components/common/Select";
import { PageHeader, PageShell } from "../../presentation/components/common/VisualPrimitives";
import { useActionFeedback } from "../../presentation/components/common/ActionFeedback";
import { SupplierReleaseReviewPanel } from "./SupplierReleaseReviewPanel";
import { SupplierLegacyHistory } from "./SupplierLegacyHistory";

export function OperationsStatusPage() {
  const actionFeedback = useActionFeedback();
  const { locale, t } = useI18n();
  // The review tables are introduced with the verified-upload cutover. Keep the
  // panel closed until the corresponding schema and worker route are live in
  // this environment; the legacy status centre must remain usable on its own.
  const releaseReviewEnabled = import.meta.env.VITE_SUPPLIER_RELEASE_REVIEW_ENABLED === "true";
  const numberLocale = locale === "tr" ? "tr-TR" : "en-US";
  const [operationsRows, setOperationsRows] = useState<SupplierOperationsStatusRow[]>([]);
  const [catalogIntegrity, setCatalogIntegrity] = useState<CatalogIntegritySummary | null>(null);
  const [catalogBrandOperations, setCatalogBrandOperations] = useState<CatalogOperationsBrandStatus[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierSummary[]>([]);
  const [loadingOperations, setLoadingOperations] = useState(false);
  const [operationsErrorKey, setOperationsErrorKey] = useState<string | null>(null);
  const operationsLoadInFlight = useRef(false);
  const operationsLoadedOnce = useRef(false);
  const [operationsSearch, setOperationsSearch] = useState("");
  const [operationsSupplier, setOperationsSupplier] = useState("");
  const [enrichmentBrandSearch, setEnrichmentBrandSearch] = useState("");

  const reloadOperationsStatus = useCallback(async () => {
    if (operationsLoadInFlight.current) return;
    operationsLoadInFlight.current = true;
    setLoadingOperations(true);
    setOperationsErrorKey(null);
    let lastError: unknown = null;
    const retryDelays = [0, 750, 2000];
    try {
      for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
        if (retryDelays[attempt] > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelays[attempt]));
        }
        try {
          const refreshedSuppliers = await fetchCloudSuppliers();
          const [result, integrity, brandOperations] = await Promise.all([
            fetchCloudSupplierOperationsStatusAll(refreshedSuppliers),
            fetchCatalogIntegritySummary().catch(() => null),
            fetchCatalogOperationsBrandStatus(100).catch(() => []),
          ]);
          setSuppliers(refreshedSuppliers);
          setOperationsRows(result);
          setCatalogIntegrity(integrity);
          setCatalogBrandOperations(brandOperations);
          setOperationsErrorKey(null);
          operationsLoadedOnce.current = true;
          return;
        } catch (caught) {
          lastError = caught;
        }
      }
      console.error(lastError);
      // Keep the last good table visible during a transient refresh failure.
      setOperationsErrorKey(operationsLoadedOnce.current ? null : "dashboard.operationsStatus.loadFailed");
    } finally {
      operationsLoadInFlight.current = false;
      setLoadingOperations(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!cancelled) await reloadOperationsStatus();
    };
    const initialTimer = window.setTimeout(() => void run(), 600);
    const intervalId = window.setInterval(() => void run(), 45 * 1000);
    const handleFocus = () => void run();
    window.addEventListener("focus", handleFocus);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [reloadOperationsStatus]);

  const supplierOptions = suppliers.map((supplier) => ({
    value: supplier.supplier_id,
    label: supplier.name,
  }));
  const operationsSupplierOptions = [{ value: "", label: t("dashboard.operationsStatus.allSuppliers") }, ...supplierOptions];
  const filteredOperationsRows = operationsRows.filter((row) => {
    const search = operationsSearch.trim().toLowerCase();
    const matchesSearch = !search || includesLooseText(row.brand, search) || includesLooseText(row.supplier_name, search);
    const matchesSupplier = !operationsSupplier || row.supplier_id === operationsSupplier;
    return matchesSearch && matchesSupplier;
  });
  const filteredCatalogBrandOperations = catalogBrandOperations.filter((row) => {
    const search = enrichmentBrandSearch.trim();
    return !search || includesLooseText(row.brand, search);
  });

  function formatCount(value: number | null | undefined) {
    return Number(value || 0).toLocaleString(numberLocale);
  }

  function formatIntegrityCount(value: number | null | undefined) {
    return value == null ? "—" : formatCount(value);
  }

  function formatPercent(value: number | null | undefined) {
    return value == null ? "—" : `${value.toLocaleString(numberLocale, { maximumFractionDigits: 1 })}%`;
  }

  function enrichmentStatus(row: CatalogOperationsBrandStatus) {
    const total = row.total_products || 0;
    const missing = [
      row.missing_ean_count,
      row.missing_oem_count,
      row.missing_vehicle_count,
      row.missing_vehicle_model_count,
      row.missing_description_tr_count,
      row.missing_market_segment_count,
      row.missing_image_count,
    ];
    const populatedFieldCount = missing.reduce((count, value) => count + Math.max(0, total - (value || 0)), 0);
    if (total > 0 && populatedFieldCount === total * missing.length) {
      return { label: t("catalog.integrity.enrichmentComplete"), tone: "complete" };
    }
    if (populatedFieldCount > 0) return { label: t("catalog.integrity.enrichmentPartial"), tone: "partial" };
    return { label: t("catalog.integrity.enrichmentNotStarted"), tone: "idle" };
  }

  function formatDateTime(value: string | null | undefined) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(locale === "tr" ? "tr-TR" : "en-US", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDurationMs(value: number | null | undefined) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    const seconds = Math.max(0, Math.round(value / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  function toImportEngineStatus(status: string | null | undefined): ImportEngineStatus {
    switch (String(status || "").toLowerCase()) {
      case "completed":
        return "completed";
      case "running":
        return "finalizing";
      case "pending":
      case "waiting":
        return "validated";
      case "failed":
        return "failed";
      default:
        return "idle";
    }
  }

  function statusTone(status: string | null | undefined) {
    return mapImportStatusToTone(toImportEngineStatus(status));
  }

  function resolveWorkerState(
    stateValue: string | null | undefined,
    heartbeatAt: string | null | undefined,
  ) {
    const state = String(stateValue || "queued");
    if (state === "running" && heartbeatAt) {
      const lastProgress = new Date(heartbeatAt).getTime();
      if (Number.isFinite(lastProgress) && Date.now() - lastProgress > 15 * 60 * 1000) return "stalled";
    }
    return state;
  }

  function supplierWorkerState(row: SupplierOperationsStatusRow) {
    return resolveWorkerState(row.supplier_import_worker_state, row.supplier_import_last_heartbeat_at);
  }

  function supplierWorkerStateLabel(row: SupplierOperationsStatusRow) {
    if (supplierWorkerState(row) === "unknown") return locale === "tr" ? "Çalışma durumu bilinmiyor" : "Worker activity unknown";
    return t(`dashboard.operationsStatus.workerState.${supplierWorkerState(row)}`);
  }

  function supplierWorkerStateTone(row: SupplierOperationsStatusRow) {
    const state = supplierWorkerState(row);
    if (state === "completed") return "completed";
    if (state === "failed" || state === "stalled") return "failed";
    if (state === "lock_waiting" || state === "queued" || state === "unknown") return "pending";
    return "running";
  }

  function catalogWorkerStateLabel(row: SupplierOperationsStatusRow) {
    const state = resolveWorkerState(row.catalog_sync_worker_state, row.catalog_sync_last_progress_at);
    return t(`dashboard.operationsStatus.workerState.${state}`);
  }

  function catalogWorkerStateTone(row: SupplierOperationsStatusRow) {
    const state = resolveWorkerState(row.catalog_sync_worker_state, row.catalog_sync_last_progress_at);
    if (state === "completed") return "completed";
    if (state === "failed" || state === "stalled") return "failed";
    if (state === "lock_waiting" || state === "queued") return "pending";
    return "running";
  }

  function supportsRegisteredRetry(operationType: string) {
    if (!isRegisteredOperation(operationType)) return true;
    return getOperationDefinition(operationType)?.supports_retry ?? true;
  }

  function isOperationsFailedStatus(status: string | null | undefined) {
    return isImportFailedStatus(toImportEngineStatus(status));
  }

  const catalogIntegrityOperationStatus = catalogIntegrity?.backfill_status === "failed" || (catalogIntegrity?.failed_count || 0) > 0
    ? "failed"
    : catalogIntegrity?.initialization_state === "not_initialized"
      ? "idle"
      : catalogIntegrity?.initialization_state === "partial"
        ? "waiting"
        : !catalogIntegrity || catalogIntegrity.backfill_status !== "completed" || catalogIntegrity.pending_count > 0
          ? "running"
          : "completed";

  async function handleRetryRow(row: SupplierOperationsStatusRow) {
    try {
      const supplier = row.supplier_name;
      const brand = row.brand;
      if (row.supplier_import_status === "failed" && row.supplier_import_run_id) {
        actionFeedback.begin(t("dashboard.operationsStatus.retryingSupplierImport", { supplier, brand }));
        await retrySupplierPriceImportFinalize(row.supplier_import_run_id);
      } else if (row.catalog_sync_status === "failed" && row.supplier_import_run_id) {
        actionFeedback.begin(t("dashboard.operationsStatus.retryingCatalogSync", { supplier, brand }));
        await queueSupplierPriceCatalogSync(row.supplier_import_run_id);
      } else if (row.rollup_refresh_status === "failed") {
        actionFeedback.begin(t("dashboard.operationsStatus.retryingRollupRefresh", { supplier, brand }));
        await queueSupplierPriceRollupRefresh();
      } else {
        return;
      }
      await reloadOperationsStatus();
      actionFeedback.succeed(t("dashboard.operationsStatus.retryQueued", { supplier, brand }));
    } catch (caught) {
      console.error(caught);
      actionFeedback.fail(caught instanceof Error ? caught.message : t("dashboard.operationsStatus.retryFailed"));
    }
  }

  function handleExportOperationsStatus() {
    const rows = [
      [
        t("dashboard.operationsStatus.brand"),
        t("dashboard.operationsStatus.supplier"),
        t("dashboard.operationsStatus.lastImport"),
        t("dashboard.operationsStatus.supplierImport"),
        t("dashboard.operationsStatus.rows"),
        t("dashboard.operationsStatus.catalogSync"),
        t("dashboard.operationsStatus.rollupRefresh"),
        t("dashboard.operationsStatus.customerPrice"),
        t("dashboard.operationsStatus.catalogSyncProgress"),
        t("dashboard.operationsStatus.lastSuccessfulRefresh"),
      ],
      ...filteredOperationsRows.map((row) => [
        row.brand,
        row.supplier_name,
        `${formatDateTime(row.supplier_import_started_at)} / ${formatDateTime(row.supplier_import_finished_at)} / ${formatDurationMs(row.supplier_import_duration_ms)}`,
        row.supplier_import_status,
        `${row.supplier_import_staged_rows} / ${row.supplier_import_processed_rows}`,
        row.catalog_sync_status,
        row.rollup_refresh_status,
        row.customer_price_status,
        `${row.catalog_sync_processed} / ${row.supplier_import_staged_rows} · ${row.catalog_sync_worker_state} · ${row.catalog_sync_batches} batches · ${row.catalog_sync_cursor || "-"}`,
        `${formatDateTime(row.last_successful_refresh_at)} (${row.last_successful_refresh_source || "-"})`,
      ]),
    ];
    downloadCsv("operations-status.csv", toCsv(rows));
    actionFeedback.succeed(t("dashboard.operationsStatus.csvDownloaded"));
  }

  const operationsSummary = {
    total: operationsRows.length,
    ready: operationsRows.filter((row) => row.customer_price_status === "ready").length,
    attention: operationsRows.filter((row) =>
      isOperationsFailedStatus(row.supplier_import_status) ||
      isOperationsFailedStatus(row.catalog_sync_status) ||
      isOperationsFailedStatus(row.rollup_refresh_status) ||
      supplierWorkerStateTone(row) === "failed" ||
      catalogWorkerStateTone(row) === "failed",
    ).length,
    inProgress: operationsRows.filter((row) =>
      ["running", "pending"].includes(String(row.supplier_import_status || "").toLowerCase()) ||
      ["running", "pending"].includes(String(row.catalog_sync_status || "").toLowerCase()) ||
      ["running", "pending"].includes(String(row.rollup_refresh_status || "").toLowerCase()),
    ).length,
  };
  const showLegacyDataNotice = releaseReviewEnabled && operationsLoadedOnce.current && !loadingOperations && !operationsErrorKey && !operationsRows.length;

  return (
      <PageShell className="operations-status-page">
      <PageHeader title={t("dashboard.operationsStatus.title")} subtitle={t("reports.statusCenterSubtitle")} />
      {releaseReviewEnabled ? <SupplierReleaseReviewPanel locale={locale} /> : null}
      <SupplierLegacyHistory enabled={releaseReviewEnabled}
        title={t("dashboard.operationsStatus.legacyPipelineTitle")}
        summary={t("dashboard.operationsStatus.legacyHistorySummary", { count: formatCount(operationsRows.length) })}>
      <SectionCard
        title={releaseReviewEnabled ? t("dashboard.operationsStatus.legacyPipelineTitle") : t("dashboard.operationsStatus.title")}
        className="operations-status-center"
        actions={
          <Button variant="secondary" className="button--compact" onClick={() => void reloadOperationsStatus()} busy={loadingOperations} busyLabel={t("dashboard.operationsStatus.refreshing")}>
            {t("dashboard.operationsStatus.refresh")}
          </Button>
        }
      >
        <div className="toolbar toolbar--wrap dashboard-toolbar">
          <Select value={operationsSupplier} options={operationsSupplierOptions} onChange={setOperationsSupplier} />
          <Input value={operationsSearch} placeholder={t("dashboard.operationsStatus.searchPlaceholder")} onChange={setOperationsSearch} />
          <Button variant="secondary" className="button--compact" onClick={handleExportOperationsStatus} disabled={!filteredOperationsRows.length}>
            {t("dashboard.operationsStatus.exportCsv")}
          </Button>
        </div>
        {operationsErrorKey ? <div className="error-text">{t(operationsErrorKey)}</div> : null}
        {operationsRows.length ? <div className="operations-summary-strip" aria-label={t("dashboard.operationsStatus.overviewTitle")}>
          <div className="operations-summary-card">
            <span>{t("dashboard.operationsStatus.totalScopes")}</span>
            <strong>{formatCount(operationsSummary.total)}</strong>
          </div>
          <div className="operations-summary-card operations-summary-card--success">
            <span>{t("dashboard.operationsStatus.readyScopes")}</span>
            <strong>{formatCount(operationsSummary.ready)}</strong>
          </div>
          <div className="operations-summary-card operations-summary-card--warning">
            <span>{t("dashboard.operationsStatus.inProgress")}</span>
            <strong>{formatCount(operationsSummary.inProgress)}</strong>
          </div>
          <div className="operations-summary-card operations-summary-card--danger">
            <span>{t("dashboard.operationsStatus.attentionNeeded")}</span>
            <strong>{formatCount(operationsSummary.attention)}</strong>
          </div>
        </div> : null}
        {showLegacyDataNotice ? <div className="operations-data-state operations-data-state--warning" role="status">{t("dashboard.operationsStatus.releaseRowsSeparateSource")}</div> : null}
        {filteredOperationsRows.length ? (
          <div className="supplier-operation-list">
            {filteredOperationsRows.map((row) => {
              const rowKey = `${row.supplier_id}-${row.brand}`;
              const retryEnabled =
                (supportsRegisteredRetry("supplier_import") && isOperationsFailedStatus(row.supplier_import_status)) ||
                (supportsRegisteredRetry("supplier_catalog_sync") && isOperationsFailedStatus(row.catalog_sync_status)) ||
                (supportsRegisteredRetry("supplier_rollup_refresh") && isOperationsFailedStatus(row.rollup_refresh_status));
              const hasAttention = retryEnabled || supplierWorkerStateTone(row) === "failed" || catalogWorkerStateTone(row) === "failed";
              return (
                <article key={rowKey} className={`supplier-operation-card${hasAttention ? " supplier-operation-card--attention" : ""}`}>
                  <div className="supplier-operation-card__header">
                    <div className="supplier-operation-card__identity">
                      <BrandPill brand={row.brand} compact />
                      <strong>{row.supplier_name}</strong>
                      <span className="operations-subtle">
                        {t("dashboard.operationsStatus.partsAndLines", { parts: formatCount(row.part_count), lines: formatCount(row.line_count) })}
                        {row.latest_price_date ? ` · ${t("dashboard.operationsStatus.latestPrice")} ${row.latest_price_date}` : ""}
                      </span>
                    </div>
                    <div className="supplier-operation-card__meta">
                      <span>{t("dashboard.operationsStatus.lastSuccessfulRefresh")}</span>
                      <strong>{formatDateTime(row.last_successful_refresh_at)}</strong>
                      <small>{row.last_successful_refresh_source || "-"}</small>
                    </div>
                  </div>
                  <div className="supplier-operation-card__stages">
                    <div className="supplier-operation-stage">
                      <span className="supplier-operation-stage__label">{t("dashboard.operationsStatus.supplierImport")}</span>
                      <div className="supplier-operation-stage__value">
                        <span className={`mark-badge mark-badge--${statusTone(row.supplier_import_status)}`}>{t(`statuses.${row.supplier_import_status}`)}</span>
                        <span className={`mark-badge mark-badge--${supplierWorkerStateTone(row)}`}>{supplierWorkerStateLabel(row)}</span>
                      </div>
                      <small>{formatCount(row.supplier_import_processed_rows)} / {formatCount(row.supplier_import_staged_rows)}{row.supplier_import_batches == null ? "" : ` · ${formatCount(row.supplier_import_batches)} batches`}</small>
                    </div>
                    <div className="supplier-operation-stage">
                      <span className="supplier-operation-stage__label">{t("dashboard.operationsStatus.catalogSync")}</span>
                      <div className="supplier-operation-stage__value">
                        <span className={`mark-badge mark-badge--${statusTone(row.catalog_sync_status)}`}>{t(`statuses.${row.catalog_sync_status}`)}</span>
                        <span className={`mark-badge mark-badge--${catalogWorkerStateTone(row)}`}>{catalogWorkerStateLabel(row)}</span>
                      </div>
                      <small>{formatCount(row.catalog_sync_processed)} / {formatCount(row.supplier_import_staged_rows)} · {formatCount(row.catalog_sync_batches)} batches</small>
                    </div>
                    <div className="supplier-operation-stage">
                      <span className="supplier-operation-stage__label">{t("dashboard.operationsStatus.customerPrice")}</span>
                      <div className="supplier-operation-stage__value">
                        <span className={`mark-badge mark-badge--${statusTone(row.customer_price_status)}`}>{row.customer_price_status === "unavailable" ? (locale === "tr" ? "Durum görüntülenemiyor" : "Status unavailable") : t(`statuses.${row.customer_price_status}`)}</span>
                      </div>
                      <small>{row.customer_price_status === "unavailable" ? (locale === "tr" ? "Fiyat özetinin durumu bu hesapla görüntülenemiyor." : "Rollup status cannot be viewed with this account.") : row.customer_price_waiting_message || t("dashboard.operationsStatus.readyToGenerate")}</small>
                    </div>
                  </div>
                  <div className="supplier-operation-card__footer">
                    <span className="operations-subtle">{t("dashboard.operationsStatus.activePriceSource")}: {formatDateTime(row.last_successful_import_at)}</span>
                    <div className="supplier-operation-card__actions">
                      {hasAttention ? (
                        <details className="supplier-operation-card__details">
                          <summary>{t("dashboard.operationsStatus.viewTechnicalDetails")}</summary>
                          <div>
                            {row.supplier_import_error_message ? <p>{row.supplier_import_error_message}</p> : null}
                            {row.catalog_sync_error_message ? <p>{row.catalog_sync_error_message}</p> : null}
                            {row.rollup_refresh_error_message ? <p>{row.rollup_refresh_error_message}</p> : null}
                            <p>{t("dashboard.operationsStatus.lastProgress")}: {formatDateTime(row.supplier_import_last_progress_at || row.supplier_import_last_heartbeat_at)}</p>
                          </div>
                        </details>
                      ) : null}
                      {retryEnabled ? <Button variant="secondary" className="button--compact" onClick={() => void handleRetryRow(row)}>{t("common.retry")}</Button> : null}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : !operationsErrorKey && !showLegacyDataNotice ? (
          <div className="chart-placeholder">
            {loadingOperations ? t("dashboard.operationsStatus.loading") : t("dashboard.operationsStatus.noRowsMatchCurrentFilters")}
          </div>
        ) : null}
      </SectionCard>
      </SupplierLegacyHistory>
      <details className="operations-secondary-details">
        <summary>
          <span>{t("catalog.integrity.title")}</span>
          <small>{t("catalog.integrity.scorecardHowToReadTitle")}</small>
        </summary>
        <SectionCard
          title={t("catalog.integrity.title")}
          className="catalog-operations-center"
          actions={
            <Button variant="secondary" className="button--compact" onClick={() => void reloadOperationsStatus()} busy={loadingOperations} busyLabel={t("dashboard.operationsStatus.refreshing")}>
              {t("catalog.integrity.refresh")}
            </Button>
          }
        >
        {operationsLoadedOnce.current && !catalogIntegrity ? <div className="operations-data-state operations-data-state--warning" role="status">{t("catalog.integrity.dataUnavailable")}</div> : null}
        {catalogIntegrity?.initialization_state === "not_initialized" ? <div className="warning-text">{t("catalog.integrity.notInitialized")}</div> : null}
        {catalogIntegrity?.initialization_state === "partial" ? <div className="warning-text">{t("catalog.integrity.partial")}</div> : null}
        {catalogIntegrity?.initialization_state === "running" ? (
          <div className="operations-subtle">
            {t("catalog.integrity.runningProgress", {
              processed: formatCount(catalogIntegrity.evaluated_products),
              total: formatCount(catalogIntegrity.total_products),
            })}
          </div>
        ) : null}
        {catalogIntegrity?.initialization_state === "failed" ? <div className="error-text">{catalogIntegrity.backfill_error || t("catalog.integrity.syncFailed")}</div> : null}
        {catalogIntegrity ? <>
        <div className="metric-strip catalog-integrity-summary">
          <div className="metric-tile metric-tile--info"><span className="metric-tile__label">{t("catalog.integrity.total")}</span><strong className="metric-tile__value">{formatIntegrityCount(catalogIntegrity?.total_products)}</strong></div>
          <div className="metric-tile metric-tile--success"><span className="metric-tile__label">{t("catalog.integrity.clear")}</span><strong className="metric-tile__value">{formatIntegrityCount(catalogIntegrity?.clear_count)}</strong></div>
          <div className="metric-tile metric-tile--warning"><span className="metric-tile__label">{t("catalog.integrity.incomplete")}</span><strong className="metric-tile__value">{formatIntegrityCount(catalogIntegrity?.incomplete_count)}</strong></div>
          <div className="metric-tile metric-tile--danger"><span className="metric-tile__label">{t("catalog.integrity.conflict")}</span><strong className="metric-tile__value">{formatIntegrityCount(catalogIntegrity?.conflict_count)}</strong></div>
          <div className="metric-tile metric-tile--info"><span className="metric-tile__label">{t("catalog.integrity.pending")}</span><strong className="metric-tile__value">{formatIntegrityCount(catalogIntegrity?.pending_count)}</strong></div>
          <div className="metric-tile metric-tile--danger"><span className="metric-tile__label">{t("catalog.integrity.failed")}</span><strong className="metric-tile__value">{formatIntegrityCount(catalogIntegrity?.failed_count)}</strong></div>
        </div>
        <div className="catalog-operations-kpis" aria-label={t("catalog.integrity.operationalHealth")}>
          <div><span>{t("catalog.integrity.dataCompleteness")}</span><strong>{formatPercent(catalogIntegrity?.data_completeness_percent)}</strong></div>
          <div><span>{t("catalog.integrity.evaluationCoverage")}</span><strong>{formatPercent(catalogIntegrity?.evaluation_coverage_percent)}</strong></div>
          <div><span>{t("catalog.integrity.evaluatedProducts")}</span><strong>{formatIntegrityCount(catalogIntegrity?.evaluated_products)}</strong></div>
          <div><span>{t("catalog.integrity.queueDepth")}</span><strong>{formatIntegrityCount(catalogIntegrity?.queue_depth)}</strong></div>
        </div>
        <div className="catalog-operations-explainer" role="note">
          <strong>{t("catalog.integrity.scorecardHowToReadTitle")}</strong>
          <p>{t("catalog.integrity.scorecardHowToReadBody")}</p>
          <div className="catalog-operations-explainer__rules">
            <span><b>{t("catalog.integrity.scorecardCoreLabel")}</b> {t("catalog.integrity.scorecardCoreRule")}</span>
            <span><b>{t("catalog.integrity.scorecardMissingLabel")}</b> {t("catalog.integrity.scorecardMissingRule")}</span>
            <span><b>{t("catalog.integrity.scorecardEnrichmentLabel")}</b> {t("catalog.integrity.scorecardEnrichmentRule")}</span>
          </div>
        </div>
        <div className="catalog-field-health">
          <span><small>{t("catalog.integrity.missingDescription")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_description_count)}</strong></span>
          <span><small>{t("catalog.integrity.missingOrigin")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_origin_count)}</strong></span>
          <span><small>{t("catalog.integrity.missingHsCode")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_hs_code_count)}</strong></span>
          <span><small>{t("catalog.integrity.missingWeight")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_weight_count)}</strong></span>
          <span><small>{t("catalog.integrity.missingEanShort")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_ean_count)}</strong></span>
          <span><small>{t("catalog.integrity.missingOem")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_oem_count)}</strong></span>
          <span><small>{t("catalog.integrity.missingVehicle")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_vehicle_count)}</strong></span>
          <span><small>{t("catalog.integrity.missingImage")}</small><strong>{formatIntegrityCount(catalogIntegrity?.missing_image_count)}</strong></span>
        </div>
        </> : null}
        {catalogBrandOperations.length ? (
          <div className="catalog-brand-operations">
            <div className="catalog-brand-operations__heading">
              <strong>{t("catalog.integrity.enrichmentTitle")}</strong>
              <span>{t("catalog.integrity.enrichmentHint")}</span>
            </div>
            <div className="catalog-enrichment-progress__toolbar">
              <Input
                value={enrichmentBrandSearch}
                placeholder={t("catalog.integrity.enrichmentBrandSearchPlaceholder")}
                onChange={setEnrichmentBrandSearch}
              />
              <span className="catalog-enrichment-progress__result-count">
                {t("catalog.integrity.enrichmentBrandsShown", { count: formatCount(filteredCatalogBrandOperations.length) })}
              </span>
            </div>
            {filteredCatalogBrandOperations.length ? (
              <div className="catalog-enrichment-table-wrap">
                <table className="catalog-enrichment-table">
                  <thead>
                    <tr>
                      <th>{t("catalog.integrity.brand")}</th>
                      <th>{t("catalog.integrity.products")}</th>
                      <th>{t("catalog.integrity.coreCompleteness")}</th>
                      <th>{t("catalog.integrity.incomplete")}</th>
                      <th>{t("catalog.integrity.enrichmentEan")}</th>
                      <th>{t("catalog.integrity.enrichmentOem")}</th>
                      <th>{t("catalog.integrity.enrichmentVehicle")}</th>
                      <th>{t("catalog.integrity.enrichmentVehicleModel")}</th>
                      <th>{t("catalog.integrity.enrichmentDescriptionTr")}</th>
                      <th>{t("catalog.integrity.enrichmentMarketSegment")}</th>
                      <th>{t("catalog.integrity.enrichmentImage")}</th>
                      <th>{t("catalog.integrity.enrichmentCoverage")}</th>
                      <th>{t("catalog.integrity.snapshot")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCatalogBrandOperations.map((row) => {
                      const status = enrichmentStatus(row);
                      return (
                        <tr key={row.brand_id}>
                          <td>
                            <div className="catalog-enrichment-table__brand">
                              <BrandPill brand={row.brand} compact />
                              <small>{status.label}</small>
                              <small className="catalog-enrichment-table__summary">
                                {t("catalog.integrity.brandCoreSummary", {
                                  complete: formatCount(row.complete_count),
                                  total: formatCount(row.total_products),
                                  percent: formatPercent(row.data_completeness_percent),
                                })}
                              </small>
                            </div>
                          </td>
                          <td>{formatCount(row.total_products)}</td>
                          <td>{formatPercent(row.data_completeness_percent)}</td>
                          <td>{formatCount(row.incomplete_count)}</td>
                          <td>{formatCount(row.missing_ean_count)}</td>
                          <td>{formatCount(row.missing_oem_count)}</td>
                          <td>{formatCount(row.missing_vehicle_count)}</td>
                          <td>{formatCount(row.missing_vehicle_model_count)}</td>
                          <td>{formatCount(row.missing_description_tr_count)}</td>
                          <td>{formatCount(row.missing_market_segment_count)}</td>
                          <td>{formatCount(row.missing_image_count)}</td>
                          <td><span className={`catalog-enrichment-progress__status is-${status.tone}`}>{status.label}</span></td>
                          <td>
                            <div className="catalog-enrichment-table__meta">
                              <small>{t("catalog.integrity.snapshot")}</small>
                              <strong>{formatDateTime(row.projection_updated_at)}</strong>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <div className="catalog-enrichment-progress__empty">{t("catalog.integrity.enrichmentNoBrandMatches")}</div>}
          </div>
        ) : null}
        <div className="meta-row catalog-meta-strip">
          {catalogIntegrity?.last_catalog_change_at ? <span>{t("catalog.integrity.lastCatalogChange")}: <strong>{new Date(catalogIntegrity.last_catalog_change_at).toLocaleString(locale)}</strong></span> : null}
          {catalogIntegrity?.last_evaluated_at ? <span>{t("catalog.integrity.lastEvaluation")}: <strong>{new Date(catalogIntegrity.last_evaluated_at).toLocaleString(locale)}</strong></span> : null}
        </div>
        </SectionCard>
      </details>
    </PageShell>
  );
}
