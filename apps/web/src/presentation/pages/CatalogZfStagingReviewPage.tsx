import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchCatalogZfStagingReview } from "../../infrastructure/api/catalogZfStagingReviewApi";
import type {
  CatalogZfStagingReviewFilters,
  CatalogZfStagingReviewItem,
  CatalogZfStagingReviewResponse,
} from "../../types/catalogZfStagingReview";
import { useI18n } from "../../i18n/I18nProvider";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
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

const DEFAULT_LIMIT = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const BRAND_OPTIONS = ["ZF", "Sachs", "Lemforder", "TRW", "Wabco", "Boge"] as const;
const EVENT_OPTIONS = ["STAGED", "QUARANTINED", "REVIEW_REQUESTED", "REJECTED", "DEFERRED", "SUPERSEDED", "CANCELLED"] as const;
const QUARANTINE_OPTIONS = ["all", "eligible", "quarantined"] as const;

type ReviewFilters = Required<Pick<CatalogZfStagingReviewFilters, "candidateId" | "runId" | "brand" | "latestEventType" | "quarantine" | "cursor" | "limit">> & {
  selected: string;
};

type TranslateFn = (path: string, params?: Record<string, string | number>) => string;

function readFiltersFromUrl(): ReviewFilters {
  if (typeof window === "undefined") return { candidateId: "", runId: "", brand: "", latestEventType: "", quarantine: "all", cursor: "", limit: DEFAULT_LIMIT, selected: "" };
  const params = new URLSearchParams(window.location.search);
  const rawLimit = Number(params.get("limit") || DEFAULT_LIMIT);
  const brand = BRAND_OPTIONS.includes(params.get("brand") as (typeof BRAND_OPTIONS)[number]) ? String(params.get("brand")) : "";
  const latestEventType = EVENT_OPTIONS.includes(params.get("latest_event_type") as (typeof EVENT_OPTIONS)[number]) ? String(params.get("latest_event_type")) : "";
  const quarantine = QUARANTINE_OPTIONS.includes(params.get("quarantine") as (typeof QUARANTINE_OPTIONS)[number]) ? (String(params.get("quarantine")) as ReviewFilters["quarantine"]) : "all";
  return {
    candidateId: String(params.get("candidate_id") || ""),
    runId: String(params.get("run_id") || ""),
    brand,
    latestEventType,
    quarantine,
    cursor: String(params.get("cursor") || ""),
    limit: Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 50 ? rawLimit : DEFAULT_LIMIT,
    selected: String(params.get("selected") || ""),
  };
}

function writeFiltersToUrl(filters: ReviewFilters) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const params = url.searchParams;
  for (const [key, value] of [["candidate_id", filters.candidateId], ["run_id", filters.runId], ["brand", filters.brand], ["latest_event_type", filters.latestEventType], ["quarantine", filters.quarantine === "all" ? "" : filters.quarantine], ["cursor", filters.cursor], ["selected", filters.selected]] as const) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  if (filters.limit === DEFAULT_LIMIT) params.delete("limit");
  else params.set("limit", String(filters.limit));
  const query = params.toString();
  window.history.replaceState({}, "", `${url.pathname}${query ? `?${query}` : ""}${url.hash}`);
}

function itemKey(item: CatalogZfStagingReviewItem) {
  return item.id || `${item.brand}:${item.normalized_code}`;
}

function emptyDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function validHttpUrl(value: string | null) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatDate(value: string | null, locale: string) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function humanize(value: string | null | undefined) {
  return String(value || "-").replace(/[_-]+/g, " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function jsonText(value: unknown) {
  if (Array.isArray(value) && value.length === 0) return "-";
  try {
    const text = JSON.stringify(value);
    return text && text !== "[]" ? text : "-";
  } catch {
    return "-";
  }
}

function eventTone(value: string | null): "neutral" | "success" | "info" | "warning" | "danger" {
  if (value === "STAGED") return "success";
  if (value === "REVIEW_REQUESTED") return "info";
  if (value === "QUARANTINED" || value === "DEFERRED") return "warning";
  if (value === "REJECTED" || value === "CANCELLED") return "danger";
  return "neutral";
}

type DetailRowProps = { label: string; value: ReactNode };
function DetailRow({ label, value }: DetailRowProps) {
  return <div className="catalog-zf-staging-review-detail-row"><dt>{label}</dt><dd>{value}</dd></div>;
}

type MetricProps = { label: string; value: string | number; tone?: "neutral" | "success" | "info" | "warning" | "danger" };
function Metric({ label, value, tone = "neutral" }: MetricProps) {
  return <div className={`catalog-zf-staging-review-metric catalog-zf-staging-review-metric--${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

type CatalogZfStagingReviewPageProps = { loadReview?: typeof fetchCatalogZfStagingReview };

export function CatalogZfStagingReviewPage({ loadReview = fetchCatalogZfStagingReview }: CatalogZfStagingReviewPageProps) {
  const { locale, t } = useI18n();
  const [filters, setFilters] = useState<ReviewFilters>(() => readFiltersFromUrl());
  const [response, setResponse] = useState<CatalogZfStagingReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [candidateIdDraft, setCandidateIdDraft] = useState(() => readFiltersFromUrl().candidateId);
  const [runIdDraft, setRunIdDraft] = useState(() => readFiltersFromUrl().runId);
  const hasLoadedOnceRef = useRef(false);
  const detailPanelRef = useRef<HTMLElement | null>(null);
  const c: TranslateFn = (key, params) => t(`catalog.zfStagingReview.${key}`, params);
  const items = response?.items || [];
  const page = response?.page || null;
  const selectedItem = items.find((item) => itemKey(item) === filters.selected) || null;

  useEffect(() => writeFiltersToUrl(filters), [filters]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function run() {
      setError("");
      setLoading(!hasLoadedOnceRef.current);
      setRefreshing(hasLoadedOnceRef.current);
      try {
        const result = await loadReview({
          candidateId: filters.candidateId,
          runId: filters.runId,
          brand: filters.brand,
          latestEventType: filters.latestEventType,
          quarantine: filters.quarantine,
          cursor: filters.cursor,
          limit: filters.limit,
          signal: controller.signal,
        });
        if (cancelled) return;
        setResponse(result);
        if (filters.selected && !result.items.some((item) => itemKey(item) === filters.selected)) {
          setFilters((current) => ({ ...current, selected: "" }));
        }
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
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
  }, [filters.brand, filters.candidateId, filters.cursor, filters.latestEventType, filters.limit, filters.quarantine, filters.runId, loadReview, reloadTick]);

  useEffect(() => {
    if (!selectedItem) return;
    window.requestAnimationFrame(() => detailPanelRef.current?.focus());
  }, [selectedItem]);

  const brandOptions = useMemo(() => [{ value: "", label: c("filters.allBrands") }, ...BRAND_OPTIONS.map((value) => ({ value, label: value }))], [t]);
  const eventOptions = useMemo(() => [{ value: "", label: c("filters.allEvents") }, ...EVENT_OPTIONS.map((value) => ({ value, label: humanize(value) }))], [t]);
  const quarantineOptions = useMemo(() => QUARANTINE_OPTIONS.map((value) => ({ value, label: c(`filters.quarantine.${value}`) })), [t]);
  const pageSizeOptions = useMemo(() => PAGE_SIZE_OPTIONS.map((value) => ({ value: String(value), label: String(value) })), []);
  const hasActiveFilters = Boolean(filters.candidateId || filters.runId || filters.brand || filters.latestEventType || filters.quarantine !== "all" || filters.cursor);

  function resetCursor(patch: Partial<ReviewFilters>) {
    setFilters((current) => ({ ...current, ...patch, cursor: "", selected: "" }));
  }

  function clearFilters() {
    setCandidateIdDraft("");
    setRunIdDraft("");
    setFilters((current) => ({ ...current, candidateId: "", runId: "", brand: "", latestEventType: "", quarantine: "all", cursor: "", selected: "", limit: DEFAULT_LIMIT }));
  }

  function closeDetail() {
    const key = filters.selected;
    setFilters((current) => ({ ...current, selected: "" }));
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-zf-candidate-key="${CSS.escape(key)}"]`)?.focus());
  }

  function nextPage() {
    if (!page?.next_cursor) return;
    setFilters((current) => ({ ...current, cursor: page.next_cursor || "", selected: "" }));
  }

  return (
    <PageShell className="catalog-zf-staging-review-page">
      <PageHeader
        eyebrow={t("nav.zfStagingEvidence")}
        title={c("title")}
        subtitle={c("subtitle")}
        status={<div className="document-marks document-marks--compact"><StatusBadge tone="info">{c("readOnlyBadge")}</StatusBadge><StatusBadge tone="neutral">{response?.schema_version || "catalog-zf-staging-review.v1"}</StatusBadge></div>}
        actions={<><Button variant="secondary" onClick={clearFilters} disabled={!hasActiveFilters || refreshing}>{c("actions.clearFilters")}</Button><Button onClick={() => setReloadTick((value) => value + 1)} busy={refreshing} busyLabel={c("actions.refreshing")}>{c("actions.refresh")}</Button></>}
      />
      <InlineAlert tone="info" title={c("readOnlyNoticeTitle")}>{c("readOnlyNoticeBody")}</InlineAlert>
      <div className="metric-strip catalog-zf-staging-review-summary">
        <Metric label={c("summary.visibleCandidates")} value={page?.returned_count ?? 0} />
        <Metric label={c("summary.quarantined") } value={items.filter((item) => Boolean(item.quarantine_class)).length} tone="warning" />
        <Metric label={c("summary.staged") } value={items.filter((item) => item.latest_event_type === "STAGED").length} tone="success" />
        <Metric label={c("summary.reviewRequested") } value={items.filter((item) => item.latest_event_type === "REVIEW_REQUESTED").length} tone="info" />
        <Metric label={c("summary.limited") } value={items.filter((item) => item.limitation_flags.length > 0).length} tone="danger" />
      </div>
      <CompactFilterBar className="catalog-zf-staging-review-filters">
        <Input label={c("filters.candidateId")} value={candidateIdDraft} placeholder={c("filters.candidateIdPlaceholder")} onChange={setCandidateIdDraft} onEnter={() => resetCursor({ candidateId: candidateIdDraft.trim() })} />
        <Input label={c("filters.runId")} value={runIdDraft} placeholder={c("filters.runIdPlaceholder")} onChange={setRunIdDraft} onEnter={() => resetCursor({ runId: runIdDraft.trim() })} />
        <Select label={c("filters.brand")} value={filters.brand} options={brandOptions} onChange={(value) => resetCursor({ brand: value })} />
        <Select label={c("filters.event")} value={filters.latestEventType} options={eventOptions} onChange={(value) => resetCursor({ latestEventType: value })} />
        <Select label={c("filters.quarantine.label")} value={filters.quarantine} options={quarantineOptions} onChange={(value) => resetCursor({ quarantine: value as ReviewFilters["quarantine"] })} />
        <Select label={c("filters.pageSize")} value={String(filters.limit)} options={pageSizeOptions} onChange={(value) => resetCursor({ limit: Number(value) || DEFAULT_LIMIT })} />
      </CompactFilterBar>
      {error ? <InlineAlert tone="danger" title={c("errors.title")}>{error}</InlineAlert> : null}
      <div className="catalog-zf-staging-review-layout">
        <section className="catalog-zf-staging-review-layout__table" aria-label={c("table.ariaLabel")}>
          <div className="meta-row catalog-meta-strip"><span>{c("meta.visibleRows", { returned: page?.returned_count ?? items.length })}</span><span>{c("meta.tenantBound")}</span>{page?.has_more ? <Button variant="secondary" className="button--compact" onClick={nextPage}>{c("actions.nextPage")}</Button> : null}</div>
          {loading ? <LoadingState title={c("loading.title")}>{c("loading.body")}</LoadingState> : items.length ? (
            <div className="table-wrap table-wrap--tall">
              <table className="data-table catalog-zf-staging-review-table">
                <thead><tr><th>{c("table.candidate")}</th><th>{c("table.brandCode")}</th><th>{c("table.lifecycle")}</th><th>{c("table.event")}</th><th>{c("table.source")}</th><th>{c("table.details")}</th></tr></thead>
                <tbody>{items.map((item) => {
                  const key = itemKey(item);
                  const selected = key === filters.selected;
                  return <tr key={key} data-zf-candidate-key={key} tabIndex={0} aria-selected={selected} className={`data-table__row--clickable${selected ? " data-table__row--active" : ""}`} onClick={() => setFilters((current) => ({ ...current, selected: key }))} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setFilters((current) => ({ ...current, selected: key })); } }}>
                    <td data-label={c("table.candidate")}><div className="catalog-zf-staging-review-primary-cell"><strong>{emptyDash(item.proposed_display_code)}</strong><span>{item.id}</span></div></td>
                    <td data-label={c("table.brandCode")}><div className="catalog-zf-staging-review-primary-cell"><StatusBadge tone="info">{emptyDash(item.brand)}</StatusBadge><span>{emptyDash(item.normalized_code)}</span></div></td>
                    <td data-label={c("table.lifecycle")}><div className="catalog-zf-staging-review-primary-cell"><StatusBadge tone={item.quarantine_class ? "warning" : "success"}>{humanize(item.lifecycle_status)}</StatusBadge><span>{item.quarantine_class ? c("states.quarantined") : c("states.eligible")}</span></div></td>
                    <td data-label={c("table.event")}><div className="catalog-zf-staging-review-primary-cell"><StatusBadge tone={eventTone(item.latest_event_type)}>{humanize(item.latest_event_type)}</StatusBadge><span>{formatDate(item.latest_event_at, locale)}</span></div></td>
                    <td data-label={c("table.source")}><div className="catalog-zf-staging-review-primary-cell"><strong>{emptyDash(item.source_id)}</strong><span>{emptyDash(item.source_schema_version)}</span></div></td>
                    <td data-label={c("table.details")}><Button variant="secondary" className="button--compact" onClick={(event) => { event.stopPropagation(); setFilters((current) => ({ ...current, selected: key })); }}>{c("table.details")}</Button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          ) : <EmptyState title={c("empty.title")}>{c("empty.body")}</EmptyState>}
        </section>
        <aside ref={detailPanelRef} className="workbench-detail-panel workbench-detail-panel--catalog catalog-zf-staging-review-detail" tabIndex={selectedItem ? -1 : undefined} onKeyDown={(event) => { if (event.key === "Escape" && selectedItem) closeDetail(); }}>
          {selectedItem ? <>
            <div className="toolbar toolbar--wrap workbench-detail-panel__dragbar"><span className="workbench-detail-panel__eyebrow">{c("detail.eyebrow")}</span><Button variant="secondary" className="button--compact" onClick={closeDetail}>{t("common.close")}</Button></div>
            <div className="workbench-detail-panel__title">{emptyDash(selectedItem.proposed_display_code)}</div>
            <div className="document-marks document-marks--compact"><StatusBadge tone="info">{emptyDash(selectedItem.brand)}</StatusBadge><StatusBadge tone={eventTone(selectedItem.latest_event_type)}>{humanize(selectedItem.latest_event_type)}</StatusBadge><StatusBadge tone={selectedItem.quarantine_class ? "warning" : "success"}>{selectedItem.quarantine_class ? c("states.quarantined") : c("states.eligible")}</StatusBadge></div>
            <dl className="catalog-zf-staging-review-detail-list">
              <DetailRow label={c("detail.candidateId")} value={selectedItem.id} />
              <DetailRow label={c("detail.normalizedCode")} value={emptyDash(selectedItem.normalized_code)} />
              <DetailRow label={c("detail.officialCode")} value={emptyDash(selectedItem.official_source_display_code)} />
              <DetailRow label={c("detail.description")} value={emptyDash(selectedItem.description)} />
              <DetailRow label={c("detail.ean")} value={emptyDash(selectedItem.ean)} />
              <DetailRow label={c("detail.weight")} value={selectedItem.weight_kg == null ? "-" : `${selectedItem.weight_kg} kg`} />
              <DetailRow label={c("detail.origin")} value={emptyDash(selectedItem.origin)} />
              <DetailRow label={c("detail.hsCode")} value={emptyDash(selectedItem.hs_code)} />
              <DetailRow label={c("detail.oem") } value={selectedItem.oem_references.length ? selectedItem.oem_references.join(", ") : "-"} />
              <DetailRow label={c("detail.vehicle") } value={jsonText(selectedItem.vehicle_applications)} />
              <DetailRow label={c("detail.fitment") } value={selectedItem.fitment_facts.length ? selectedItem.fitment_facts.join(", ") : "-"} />
              <DetailRow label={c("detail.engine") } value={selectedItem.engine_facts.length ? selectedItem.engine_facts.join(", ") : "-"} />
              <DetailRow label={c("detail.replacement") } value={jsonText(selectedItem.replacement_candidates)} />
              <DetailRow label={c("detail.supersession") } value={jsonText(selectedItem.supersession_candidates)} />
              <DetailRow label={c("detail.lifecycle") } value={`${humanize(selectedItem.lifecycle_status)}${selectedItem.lifecycle_note ? ` — ${selectedItem.lifecycle_note}` : ""}`} />
              <DetailRow label={c("detail.limitationFlags") } value={selectedItem.limitation_flags.length ? selectedItem.limitation_flags.join(", ") : c("empty.none")} />
              <DetailRow label={c("detail.observedAt") } value={formatDate(selectedItem.observed_at, locale)} />
              <DetailRow label={c("detail.createdAt") } value={formatDate(selectedItem.created_at, locale)} />
              <DetailRow label={c("detail.runId") } value={selectedItem.run_id} />
              <DetailRow label={c("detail.jobId") } value={selectedItem.job_id} />
              <DetailRow label={c("detail.contract") } value={selectedItem.contract_version} />
              <DetailRow label={c("detail.fingerprint") } value={<code>{selectedItem.payload_fingerprint}</code>} />
              <DetailRow label={c("detail.provenance") } value={`${selectedItem.source_schema_version} / ${emptyDash(selectedItem.runtime_commit)}`} />
              <DetailRow label={c("detail.source") } value={validHttpUrl(selectedItem.official_source_url) ? <a href={selectedItem.official_source_url || undefined} target="_blank" rel="noopener noreferrer">{selectedItem.official_source_url}</a> : c("empty.notAvailable")} />
              <DetailRow label={c("detail.image") } value={validHttpUrl(selectedItem.official_image_candidate_url) ? <a href={selectedItem.official_image_candidate_url || undefined} target="_blank" rel="noopener noreferrer">{c("detail.openImage")}</a> : c("empty.notAvailable")} />
            </dl>
            <InlineAlert tone="info" title={c("detail.noWriteTitle")}>{c("detail.noWriteBody")}</InlineAlert>
          </> : <EmptyState title={c("detail.emptyTitle")}>{c("detail.emptyBody")}</EmptyState>}
        </aside>
      </div>
    </PageShell>
  );
}
