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

export function OperationsStatusPage() {
  const actionFeedback = useActionFeedback();
  const { locale, t } = useI18n();
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
    if ((row.incomplete_count || 0) === 0) return { label: t("catalog.integrity.enrichmentComplete"), tone: "complete" };
    if ((row.complete_count || 0) === 0) return { label: t("catalog.integrity.enrichmentNotStarted"), tone: "idle" };
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
        `${formatDateTime(row.last_successful_refresh_at)} (${row.last_successful_refresh_source || "-"})`,
      ]),
    ];
    downloadCsv("operations-status.csv", toCsv(rows));
    actionFeedback.succeed(t("dashboard.operationsStatus.csvDownloaded"));
  }

  return (
    <PageShell className="operations-status-page">
      <PageHeader title={t("dashboard.operationsStatus.title")} subtitle={t("reports.statusCenterSubtitle")} />
      <SectionCard
        title={t("dashboard.operationsStatus.title")}
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
        {filteredOperationsRows.length ? (
          <div className="table-wrap table-wrap--tall">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("dashboard.operationsStatus.brand")}</th>
                  <th>{t("dashboard.operationsStatus.lastImport")}</th>
                  <th>{t("dashboard.operationsStatus.supplierImport")}</th>
                  <th>{t("dashboard.operationsStatus.rows")}</th>
                  <th>{t("dashboard.operationsStatus.catalogSync")}</th>
                  <th>{t("dashboard.operationsStatus.rollupRefresh")}</th>
                  <th>{t("dashboard.operationsStatus.customerPrice")}</th>
                  <th>{t("dashboard.operationsStatus.lastSuccessfulRefresh")}</th>
                  <th>{t("dashboard.operationsStatus.action")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredOperationsRows.map((row) => {
                  const rowKey = `${row.supplier_id}-${row.brand}`;
                  const retryEnabled =
                    (supportsRegisteredRetry("supplier_import") && isOperationsFailedStatus(row.supplier_import_status)) ||
                    (supportsRegisteredRetry("supplier_catalog_sync") && isOperationsFailedStatus(row.catalog_sync_status)) ||
                    (supportsRegisteredRetry("supplier_rollup_refresh") && isOperationsFailedStatus(row.rollup_refresh_status));
                  return (
                    <tr key={rowKey}>
                      <td>
                        <div className="list-stack">
                          <BrandPill brand={row.brand} compact />
                          <strong>{row.supplier_name}</strong>
                          <span className="operations-subtle">
                            {t("dashboard.operationsStatus.partsAndLines", {
                              parts: formatCount(row.part_count),
                              lines: formatCount(row.line_count),
                            })}
                            {row.latest_price_date ? ` · ${t("dashboard.operationsStatus.latestPrice")} ${row.latest_price_date}` : ""}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="list-stack">
                          <span>{t("dashboard.operationsStatus.started")}: {formatDateTime(row.supplier_import_started_at)}</span>
                          <span>{t("dashboard.operationsStatus.finished")}: {formatDateTime(row.supplier_import_finished_at)}</span>
                          <span>{t("dashboard.operationsStatus.duration")}: {formatDurationMs(row.supplier_import_duration_ms)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="list-stack">
                          <span className={`mark-badge mark-badge--${statusTone(row.supplier_import_status)}`}>{t(`statuses.${row.supplier_import_status}`)}</span>
                          {row.supplier_import_status === "failed" ? <span className="error-text">{row.supplier_import_error_message || t("dashboard.operationsStatus.failed")}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="list-stack">
                          <span>{t("dashboard.operationsStatus.staged")}: {formatCount(row.supplier_import_staged_rows)}</span>
                          <span>{t("dashboard.operationsStatus.processed")}: {formatCount(row.supplier_import_processed_rows)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="list-stack">
                          <span className={`mark-badge mark-badge--${statusTone(row.catalog_sync_status)}`}>{t(`statuses.${row.catalog_sync_status}`)}</span>
                          {row.catalog_sync_status === "failed" ? <span className="error-text">{row.catalog_sync_error_message || t("dashboard.operationsStatus.failed")}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="list-stack">
                          <span className={`mark-badge mark-badge--${statusTone(row.rollup_refresh_status)}`}>{t(`statuses.${row.rollup_refresh_status}`)}</span>
                          {row.rollup_refresh_status === "failed" ? <span className="error-text">{row.rollup_refresh_error_message || t("dashboard.operationsStatus.failed")}</span> : null}
                        </div>
                      </td>
                      <td>
                        <div className="list-stack">
                          <span className={`mark-badge mark-badge--${statusTone(row.customer_price_status)}`}>{t(`statuses.${row.customer_price_status}`)}</span>
                          <span className="operations-subtle">{row.customer_price_waiting_message || t("dashboard.operationsStatus.readyToGenerate")}</span>
                        </div>
                      </td>
                      <td>
                        <div className="list-stack">
                          <span>{formatDateTime(row.last_successful_refresh_at)}</span>
                          <span className="operations-subtle">
                            {row.last_successful_refresh_source
                              ? `${t("dashboard.operationsStatus.source")}: ${row.last_successful_refresh_source === "supplier import" ? t("dashboard.operationsStatus.supplierImport") : t("dashboard.operationsStatus.rollupRefresh")}`
                              : "-"}
                          </span>
                        </div>
                      </td>
                      <td>
                        {retryEnabled ? <Button variant="secondary" className="button--compact" onClick={() => void handleRetryRow(row)}>{t("common.retry")}</Button> : <span className="operations-subtle">-</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : !operationsErrorKey ? (
          <div className="chart-placeholder">
            {loadingOperations ? t("dashboard.operationsStatus.loading") : t("dashboard.operationsStatus.noRowsMatchCurrentFilters")}
          </div>
        ) : null}
      </SectionCard>
      <SectionCard
        title={t("catalog.integrity.title")}
        className="catalog-operations-center"
        actions={
          <Button variant="secondary" className="button--compact" onClick={() => void reloadOperationsStatus()} busy={loadingOperations} busyLabel={t("dashboard.operationsStatus.refreshing")}>
            {t("catalog.integrity.refresh")}
          </Button>
        }
      >
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
    </PageShell>
  );
}
