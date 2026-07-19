import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchCatalogObservationReview } from "../../infrastructure/api/catalogObservationReviewApi";
import type { CatalogObservationReviewItem, CatalogObservationReviewResponse } from "../../types/catalogObservationReview";
import { useI18n } from "../../i18n/I18nProvider";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { Button } from "../components/common/Button";
import { Select } from "../components/common/Select";
import {
  CompactFilterBar,
  EmptyState,
  InlineAlert,
  LoadingState,
  PageHeader,
  PageShell,
  StatusBadge,
} from "../components/common/VisualPrimitives";

const CATALOG_OBSERVATION_REVIEW_RUN_ID = "11581bfd-3a12-43d5-bb39-d6aa09e3bd96";
const DEFAULT_LIMIT = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const FIELD_FAMILY_OPTIONS = ["image_reference", "supplemental_description"] as const;
const COMPARISON_RESULT_OPTIONS = ["ENRICHMENT_CANDIDATE", "CONFLICT", "NO_CHANGE", "INSUFFICIENT_EVIDENCE", "UNSUPPORTED_FIELD"] as const;
const RECOMMENDATION_OPTIONS = ["LIKELY_ACCEPT", "MANUAL_REQUIRED", "LIKELY_REJECT", "AUTO_SAFE", "INSUFFICIENT_EVIDENCE"] as const;

type ReviewFilters = {
  fieldFamily: string;
  comparisonResult: string;
  recommendation: string;
  cursor: string;
  selected: string;
  limit: number;
};

function readFiltersFromUrl(): ReviewFilters {
  if (typeof window === "undefined") {
    return {
      fieldFamily: "",
      comparisonResult: "",
      recommendation: "",
      cursor: "",
      selected: "",
      limit: DEFAULT_LIMIT,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const rawLimit = Number(params.get("limit") || DEFAULT_LIMIT);
  return {
    fieldFamily: FIELD_FAMILY_OPTIONS.includes(params.get("field_family") as (typeof FIELD_FAMILY_OPTIONS)[number])
      ? String(params.get("field_family"))
      : "",
    comparisonResult: COMPARISON_RESULT_OPTIONS.includes(params.get("comparison_result") as (typeof COMPARISON_RESULT_OPTIONS)[number])
      ? String(params.get("comparison_result"))
      : "",
    recommendation: RECOMMENDATION_OPTIONS.includes(params.get("recommendation") as (typeof RECOMMENDATION_OPTIONS)[number])
      ? String(params.get("recommendation"))
      : "",
    cursor: String(params.get("cursor") || ""),
    selected: String(params.get("selected") || ""),
    limit: Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 50 ? rawLimit : DEFAULT_LIMIT,
  };
}

function writeFiltersToUrl(filters: ReviewFilters) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const params = url.searchParams;
  setParam(params, "field_family", filters.fieldFamily);
  setParam(params, "comparison_result", filters.comparisonResult);
  setParam(params, "recommendation", filters.recommendation);
  setParam(params, "cursor", filters.cursor);
  setParam(params, "selected", filters.selected);
  if (filters.limit !== DEFAULT_LIMIT) {
    params.set("limit", String(filters.limit));
  } else {
    params.delete("limit");
  }
  const query = params.toString();
  window.history.replaceState({}, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
}

function setParam(params: URLSearchParams, key: string, value: string) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

function itemKey(item: CatalogObservationReviewItem) {
  return item.observation_id || item.review_queue_id || `${item.product_id || ""}:${item.field_family}`;
}

function emptyDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function validHttpUrl(value: string | null | undefined) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatDate(value: string | null | undefined, locale: string, fallback = "-") {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback || value;
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function formatUnitPercent(value: number | null | undefined, locale: string, fallback = "-") {
  if (value == null || Number.isNaN(Number(value))) return fallback;
  return new Intl.NumberFormat(locale === "tr" ? "tr-TR" : "en-US", {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatScore(value: number, locale: string) {
  return Number(value || 0).toLocaleString(locale === "tr" ? "tr-TR" : "en-US", {
    maximumFractionDigits: 0,
  });
}

function badgeToneForRecommendation(value: string): "neutral" | "success" | "info" | "warning" | "danger" {
  if (value === "LIKELY_ACCEPT" || value === "AUTO_SAFE") return "success";
  if (value === "MANUAL_REQUIRED") return "warning";
  if (value === "LIKELY_REJECT" || value === "INSUFFICIENT_EVIDENCE") return "danger";
  return "neutral";
}

function badgeToneForComparison(value: string): "neutral" | "success" | "info" | "warning" | "danger" {
  if (value === "ENRICHMENT_CANDIDATE") return "info";
  if (value === "CONFLICT") return "warning";
  if (value === "NO_CHANGE") return "success";
  if (value === "INSUFFICIENT_EVIDENCE" || value === "UNSUPPORTED_FIELD") return "danger";
  return "neutral";
}

export function CatalogObservationReviewPage() {
  const { locale, t } = useI18n();
  const [filters, setFilters] = useState<ReviewFilters>(() => readFiltersFromUrl());
  const [response, setResponse] = useState<CatalogObservationReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const detailPanelRef = useRef<HTMLElement | null>(null);
  const selectedRef = useRef(filters.selected);
  const hasLoadedOnceRef = useRef(false);
  const initialSelectionAppliedRef = useRef(Boolean(filters.selected));
  const numberLocale = locale === "tr" ? "tr-TR" : "en-US";
  const c = (key: string, params?: Record<string, string | number>) => t(`catalog.observationReview.${key}`, params);

  useEffect(() => {
    selectedRef.current = filters.selected;
  }, [filters.selected]);

  useEffect(() => {
    writeFiltersToUrl(filters);
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function run() {
      setError("");
      setLoading(!hasLoadedOnceRef.current);
      setRefreshing(hasLoadedOnceRef.current);
      try {
        const result = await fetchCatalogObservationReview({
          runId: CATALOG_OBSERVATION_REVIEW_RUN_ID,
          fieldFamily: filters.fieldFamily,
          comparisonResult: filters.comparisonResult,
          recommendation: filters.recommendation,
          cursor: filters.cursor,
          limit: filters.limit,
          signal: controller.signal,
        });
        if (cancelled) return;
        setResponse(result);
        const selected = selectedRef.current;
        const selectedStillVisible = selected && result.items.some((item) => itemKey(item) === selected);
        if (!selectedStillVisible && selected) {
          setFilters((current) => ({ ...current, selected: "" }));
        }
        if (!selected && !initialSelectionAppliedRef.current && result.items[0]) {
          initialSelectionAppliedRef.current = true;
          setFilters((current) => ({ ...current, selected: itemKey(result.items[0]) }));
        }
      } catch (caught) {
        if (controller.signal.aborted || cancelled) return;
        setResponse((current) => current);
        setError(sanitizeUserFacingMessage(caught instanceof Error ? caught.message : String(caught || ""), c("errors.loadFailed")));
      } finally {
        if (!cancelled) {
          hasLoadedOnceRef.current = true;
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [filters.comparisonResult, filters.cursor, filters.fieldFamily, filters.limit, filters.recommendation, reloadTick]);

  const items = response?.items ?? [];
  const summary = response?.summary ?? null;
  const page = response?.page ?? null;
  const selectedItem = items.find((item) => itemKey(item) === filters.selected) || null;
  const hasActiveFilters = Boolean(filters.fieldFamily || filters.comparisonResult || filters.recommendation || filters.cursor);
  const evidenceUrlIsSafe = validHttpUrl(selectedItem?.evidence_url);

  const fieldFamilyOptions = useMemo(
    () => [
      { value: "", label: c("filters.allFieldFamilies") },
      ...FIELD_FAMILY_OPTIONS.map((value) => ({ value, label: fieldFamilyLabel(value, c) })),
    ],
    [t],
  );
  const comparisonOptions = useMemo(
    () => [
      { value: "", label: c("filters.allComparisonResults") },
      ...COMPARISON_RESULT_OPTIONS.map((value) => ({ value, label: comparisonLabel(value, c) })),
    ],
    [t],
  );
  const recommendationOptions = useMemo(
    () => [
      { value: "", label: c("filters.allRecommendations") },
      ...RECOMMENDATION_OPTIONS.map((value) => ({ value, label: recommendationLabel(value, c) })),
    ],
    [t],
  );
  const pageSizeOptions = useMemo(
    () => PAGE_SIZE_OPTIONS.map((value) => ({ value: String(value), label: String(value) })),
    [],
  );

  function resetCursorAndSelection(patch: Partial<ReviewFilters>) {
    initialSelectionAppliedRef.current = false;
    setFilters((current) => ({
      ...current,
      ...patch,
      cursor: "",
      selected: "",
    }));
  }

  function clearFilters() {
    initialSelectionAppliedRef.current = false;
    setFilters((current) => ({
      ...current,
      fieldFamily: "",
      comparisonResult: "",
      recommendation: "",
      cursor: "",
      selected: "",
      limit: DEFAULT_LIMIT,
    }));
  }

  function handleSelectItem(item: CatalogObservationReviewItem) {
    setFilters((current) => ({ ...current, selected: itemKey(item) }));
  }

  function handleCloseDetail() {
    const focusKey = filters.selected;
    setFilters((current) => ({ ...current, selected: "" }));
    window.requestAnimationFrame(() => {
      rowRefs.current[focusKey]?.focus();
    });
  }

  useEffect(() => {
    if (!selectedItem) return;
    window.requestAnimationFrame(() => {
      detailPanelRef.current?.focus();
    });
  }, [selectedItem]);

  function handleNextPage() {
    if (!page?.next_cursor) return;
    initialSelectionAppliedRef.current = false;
    setFilters((current) => ({
      ...current,
      cursor: page.next_cursor || "",
      selected: "",
    }));
  }

  function displayValue(value: string | number | null | undefined, fallback: string) {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function renderValue(value: string | null | undefined, fallback: string) {
    const text = String(value ?? "").trim();
    return <span className={text ? "catalog-review-value" : "muted-text"}>{text || fallback}</span>;
  }

  return (
    <PageShell className="catalog-observation-review-page">
      <PageHeader
        eyebrow={t("nav.catalogReview")}
        title={c("title")}
        subtitle={c("subtitle", { runId: CATALOG_OBSERVATION_REVIEW_RUN_ID })}
        status={
          <div className="document-marks document-marks--compact">
            <StatusBadge tone="info">{c("readOnlyBadge")}</StatusBadge>
            <StatusBadge tone="neutral">{response?.schema_version || "catalog-observation-review.v1"}</StatusBadge>
          </div>
        }
        actions={
          <>
            <Button variant="secondary" onClick={clearFilters} disabled={!hasActiveFilters || refreshing}>
              {c("actions.clearFilters")}
            </Button>
            <Button onClick={() => setReloadTick((current) => current + 1)} busy={refreshing} busyLabel={c("actions.refreshing")}>
              {c("actions.refresh")}
            </Button>
          </>
        }
      />

      <InlineAlert tone="info" title={c("readOnlyNoticeTitle")}>
        {c("readOnlyNoticeBody")}
      </InlineAlert>

      <div className="metric-strip catalog-observation-review-summary">
        <ReviewMetric label={c("summary.reviewItems")} value={summary?.review_queue_count ?? 0} locale={numberLocale} />
        <ReviewMetric label={c("summary.enrichmentCandidates")} value={summary?.comparison_totals.ENRICHMENT_CANDIDATE ?? 0} locale={numberLocale} tone="info" />
        <ReviewMetric label={c("summary.conflicts")} value={summary?.comparison_totals.CONFLICT ?? 0} locale={numberLocale} tone="danger" />
        <ReviewMetric label={c("summary.likelyAccept")} value={summary?.recommendation_totals.LIKELY_ACCEPT ?? 0} locale={numberLocale} tone="success" />
        <ReviewMetric label={c("summary.manualRequired")} value={summary?.recommendation_totals.MANUAL_REQUIRED ?? 0} locale={numberLocale} tone="warning" />
        <ReviewMetric label={c("summary.likelyReject")} value={summary?.recommendation_totals.LIKELY_REJECT ?? 0} locale={numberLocale} tone="danger" />
        <ReviewMetric label={c("summary.insufficientEvidence")} value={summary?.recommendation_totals.INSUFFICIENT_EVIDENCE ?? 0} locale={numberLocale} tone="warning" />
        <ReviewMetric label={c("summary.autoSafe")} value={summary?.recommendation_totals.AUTO_SAFE ?? 0} locale={numberLocale} tone="info" />
      </div>

      <CompactFilterBar>
        <Select
          label={c("filters.fieldFamily")}
          value={filters.fieldFamily}
          options={fieldFamilyOptions}
          onChange={(value) => resetCursorAndSelection({ fieldFamily: value })}
        />
        <Select
          label={c("filters.comparisonResult")}
          value={filters.comparisonResult}
          options={comparisonOptions}
          onChange={(value) => resetCursorAndSelection({ comparisonResult: value })}
        />
        <Select
          label={c("filters.recommendation")}
          value={filters.recommendation}
          options={recommendationOptions}
          onChange={(value) => resetCursorAndSelection({ recommendation: value })}
        />
        <Select
          label={c("filters.pageSize")}
          value={String(filters.limit)}
          options={pageSizeOptions}
          onChange={(value) => resetCursorAndSelection({ limit: Number(value) || DEFAULT_LIMIT })}
        />
      </CompactFilterBar>

      {error ? (
        <InlineAlert tone="danger" title={c("errors.title")}>
          {error}
        </InlineAlert>
      ) : null}

      <div className="catalog-observation-review-layout">
        <div className="catalog-observation-review-layout__table">
          <div className="meta-row catalog-meta-strip">
            <span>
              {c("meta.visibleRows", {
                returned: (page?.returned_count ?? items.length).toLocaleString(numberLocale),
                total: (page?.total_count ?? items.length).toLocaleString(numberLocale),
              })}
            </span>
            <span>{c("meta.runId", { runId: response?.run_id || CATALOG_OBSERVATION_REVIEW_RUN_ID })}</span>
            {page?.has_more ? (
              <Button variant="secondary" className="button--compact" onClick={handleNextPage}>
                {c("actions.nextPage")}
              </Button>
            ) : null}
          </div>

          {loading ? (
            <LoadingState title={c("loading.title")}>{c("loading.body")}</LoadingState>
          ) : items.length ? (
            <div className="table-wrap table-wrap--tall">
              <table className="data-table catalog-observation-review-table">
                <thead>
                  <tr>
                    <th>{c("table.statusPriority")}</th>
                    <th>{c("table.product")}</th>
                    <th>{c("table.brand")}</th>
                    <th>{c("table.fieldFamily")}</th>
                    <th>{c("table.currentValue")}</th>
                    <th>{c("table.observedValue")}</th>
                    <th>{c("table.comparison")}</th>
                    <th>{c("table.recommendation")}</th>
                    <th>{c("table.score")}</th>
                    <th>{c("table.sourceEvidence")}</th>
                    <th>{c("table.createdAt")}</th>
                    <th>{c("table.details")}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const key = itemKey(item);
                    const selected = key === filters.selected;
                    return (
                      <tr
                        key={key}
                        ref={(node) => {
                          rowRefs.current[key] = node;
                        }}
                        tabIndex={0}
                        aria-selected={selected}
                        className={`data-table__row--clickable${selected ? " data-table__row--active" : ""}`}
                        onClick={() => handleSelectItem(item)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            handleSelectItem(item);
                          }
                        }}
                      >
                        <td data-label={c("table.statusPriority")}>
                          <div className="catalog-review-status-cell">
                            <StatusBadge tone={badgeToneForRecommendation(item.recommendation)}>
                              {recommendationLabel(item.recommendation, c)}
                            </StatusBadge>
                            <StatusBadge tone={badgeToneForComparison(item.comparison_result)}>
                              {comparisonLabel(item.comparison_result, c)}
                            </StatusBadge>
                          </div>
                        </td>
                        <td data-label={c("table.product")}>
                          <div className="catalog-review-product-cell">
                            <strong>{emptyDash(item.product_code)}</strong>
                            <span>{emptyDash(item.normalized_product_code)}</span>
                          </div>
                        </td>
                        <td data-label={c("table.brand")}>{displayValue(item.brand_name, c("emptyValue.notAvailable"))}</td>
                        <td data-label={c("table.fieldFamily")}>{fieldFamilyLabel(item.field_family, c)}</td>
                        <td data-label={c("table.currentValue")}>{renderValue(item.product_value, c("emptyValue.emptyInProduct"))}</td>
                        <td data-label={c("table.observedValue")}>{renderValue(item.observation_value, c("emptyValue.notAvailable"))}</td>
                        <td data-label={c("table.comparison")}>
                          <StatusBadge tone={badgeToneForComparison(item.comparison_result)}>
                            {comparisonLabel(item.comparison_result, c)}
                          </StatusBadge>
                        </td>
                        <td data-label={c("table.recommendation")}>
                          <StatusBadge tone={badgeToneForRecommendation(item.recommendation)}>
                            {recommendationLabel(item.recommendation, c)}
                          </StatusBadge>
                        </td>
                        <td data-label={c("table.score")} className="numeric-cell">{formatScore(item.score, locale)}</td>
                        <td data-label={c("table.sourceEvidence")}>
                          <div className="catalog-review-evidence-cell">
                            <span>{emptyDash(item.source_display_name || item.source_key)}</span>
                            <span>{emptyDash(item.evidence_reference)}</span>
                          </div>
                        </td>
                        <td data-label={c("table.createdAt")}>{formatDate(item.created_at, locale, c("emptyValue.notAvailable"))}</td>
                        <td data-label={c("table.details")}>
                          <Button variant="secondary" className="button--compact" onClick={(event) => {
                            event.stopPropagation();
                            handleSelectItem(item);
                          }}>
                            {c("table.details")}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title={c("empty.title")}>{c("empty.body")}</EmptyState>
          )}
        </div>

        <aside
          ref={detailPanelRef}
          className="workbench-detail-panel workbench-detail-panel--catalog catalog-observation-review-detail"
          tabIndex={selectedItem ? -1 : undefined}
          onKeyDown={(event) => {
            if (event.key === "Escape" && selectedItem) {
              handleCloseDetail();
            }
          }}
        >
          {selectedItem ? (
            <>
              <div className="toolbar toolbar--wrap workbench-detail-panel__dragbar">
                <span className="workbench-detail-panel__eyebrow">{c("detail.eyebrow")}</span>
                <Button variant="secondary" className="button--compact" onClick={handleCloseDetail}>
                  {t("common.close")}
                </Button>
              </div>
              <div className="workbench-detail-panel__title">{emptyDash(selectedItem.product_code)}</div>
              <div className="document-marks document-marks--compact">
                <StatusBadge tone={badgeToneForRecommendation(selectedItem.recommendation)}>
                  {recommendationLabel(selectedItem.recommendation, c)}
                </StatusBadge>
                <StatusBadge tone={badgeToneForComparison(selectedItem.comparison_result)}>
                  {comparisonLabel(selectedItem.comparison_result, c)}
                </StatusBadge>
                <StatusBadge tone="neutral">{c("detail.score", { score: formatScore(selectedItem.score, locale) })}</StatusBadge>
              </div>

              <div className="workbench-detail-list">
                <DetailRow label={c("detail.reviewer")} value={selectedItem.reviewer || c("detail.unassigned")} />
                <DetailRow label={c("detail.decision")} value={selectedItem.decision || c("detail.notDecided")} />
                <DetailRow label={c("detail.productId")} value={displayValue(selectedItem.product_id, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.brand")} value={displayValue(selectedItem.brand_name, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.normalizedProductCode")} value={displayValue(selectedItem.normalized_product_code, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.fieldFamily")} value={fieldFamilyLabel(selectedItem.field_family, c)} />
                <DetailRow label={c("detail.comparisonResult")} value={comparisonLabel(selectedItem.comparison_result, c)} />
                <DetailRow label={c("detail.recommendation")} value={recommendationLabel(selectedItem.recommendation, c)} />
                <DetailRow label={c("detail.currentProductValue")} value={displayValue(selectedItem.product_value, c("emptyValue.emptyInProduct"))} />
                <DetailRow label={c("detail.observedValue")} value={displayValue(selectedItem.observation_value, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.normalizedCurrentValue")} value={displayValue(selectedItem.normalized_product_value, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.normalizedObservedValue")} value={displayValue(selectedItem.normalized_observation_value, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.comparisonReason")} value={displayValue(selectedItem.comparison_reason, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.source")} value={displayValue(selectedItem.source_display_name, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.sourceKey")} value={displayValue(selectedItem.source_key, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.sourceTrust")} value={`${displayValue(selectedItem.source_trust_level, c("emptyValue.notAvailable"))} / ${formatUnitPercent(selectedItem.source_trust_score, locale, c("emptyValue.notAvailable"))}`} />
                <DetailRow label={c("detail.observationConfidence")} value={formatUnitPercent(selectedItem.observation_confidence, locale, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.evidenceComplete")} value={selectedItem.evidence_complete ? c("booleans.yes") : c("booleans.no")} />
                <DetailRow label={c("detail.evidenceReference")} value={displayValue(selectedItem.evidence_reference, c("emptyValue.notAvailable"))} />
                <DetailRow
                  label={c("detail.evidenceUrl")}
                  value={
                    evidenceUrlIsSafe ? (
                      <a href={selectedItem.evidence_url || undefined} target="_blank" rel="noopener noreferrer">
                        {selectedItem.evidence_url}
                      </a>
                    ) : (
                      c("emptyValue.notAvailable")
                    )
                  }
                />
                <DetailRow label={c("detail.observedAt")} value={formatDate(selectedItem.observed_at, locale, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.runStatus")} value={displayValue(selectedItem.run_status, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.explanation")} value={displayValue(selectedItem.explanation, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.winningRule")} value={displayValue(selectedItem.winning_rule, c("emptyValue.notAvailable"))} />
                <DetailRow label={c("detail.positiveFactors")} value={selectedItem.positive_factors.length ? selectedItem.positive_factors.join("; ") : c("emptyValue.notAvailable")} />
                <DetailRow label={c("detail.negativeFactors")} value={selectedItem.negative_factors.length ? selectedItem.negative_factors.join("; ") : c("emptyValue.notAvailable")} />
                <DetailRow label={c("detail.fingerprint")} value={displayValue(selectedItem.recommendation_fingerprint, c("emptyValue.notAvailable"))} />
              </div>

              <div className="catalog-observation-review-rules">
                <strong>{c("detail.rules")}</strong>
                {selectedItem.rules.length ? (
                  selectedItem.rules.map((rule) => (
                    <div key={rule.rule} className="catalog-observation-review-rule">
                      <StatusBadge tone={rule.matched ? "success" : "neutral"}>
                        {rule.matched ? c("detail.ruleMatched") : c("detail.ruleNotMatched")}
                      </StatusBadge>
                      <div>
                        <strong>{rule.rule}</strong>
                        <span>{rule.reasons.length ? rule.reasons.join("; ") : "-"}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <span className="muted-text">-</span>
                )}
              </div>
            </>
          ) : (
            <EmptyState title={c("detail.noSelectionTitle")}>{c("detail.noSelectionBody")}</EmptyState>
          )}
        </aside>
      </div>
    </PageShell>
  );
}

function ReviewMetric({
  label,
  value,
  locale,
  tone = "info",
}: {
  label: string;
  value: number;
  locale: string;
  tone?: "info" | "success" | "warning" | "danger";
}) {
  return (
    <div className={`metric-tile metric-tile--${tone}`}>
      <span className="metric-tile__label">{label}</span>
      <strong className="metric-tile__value">{value.toLocaleString(locale)}</strong>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <span className="field__label">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function fieldFamilyLabel(value: string, translate: (key: string, params?: Record<string, string | number>) => string) {
  if (value === "image_reference") return translate("fieldFamilies.imageReference");
  if (value === "supplemental_description") return translate("fieldFamilies.supplementalDescription");
  return emptyDash(value);
}

function comparisonLabel(value: string, translate: (key: string, params?: Record<string, string | number>) => string) {
  if (value === "ENRICHMENT_CANDIDATE") return translate("comparisonResults.enrichmentCandidate");
  if (value === "CONFLICT") return translate("comparisonResults.conflict");
  if (value === "NO_CHANGE") return translate("comparisonResults.noChange");
  if (value === "INSUFFICIENT_EVIDENCE") return translate("comparisonResults.insufficientEvidence");
  if (value === "UNSUPPORTED_FIELD") return translate("comparisonResults.unsupportedField");
  return emptyDash(value);
}

function recommendationLabel(value: string, translate: (key: string, params?: Record<string, string | number>) => string) {
  if (value === "LIKELY_ACCEPT") return translate("recommendations.likelyAccept");
  if (value === "MANUAL_REQUIRED") return translate("recommendations.manualRequired");
  if (value === "LIKELY_REJECT") return translate("recommendations.likelyReject");
  if (value === "AUTO_SAFE") return translate("recommendations.autoSafe");
  if (value === "INSUFFICIENT_EVIDENCE") return translate("recommendations.insufficientEvidence");
  return emptyDash(value);
}
