import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fetchCatalogObservationReview } from "../../infrastructure/api/catalogObservationReviewApi";
import {
  reverseCatalogObservationReviewDecision,
  submitCatalogObservationReviewDecision,
} from "../../infrastructure/api/catalogObservationReviewApi";
import {
  CATALOG_OBSERVATION_REVIEW_DECISION_REASON_CODES,
  CATALOG_OBSERVATION_REVIEW_DECISION_TYPES,
  CATALOG_OBSERVATION_REVIEW_REVERSAL_REASON_CODES,
  type CatalogObservationReviewDecisionCommandInput,
  type CatalogObservationReviewDecisionCommandResult,
  type CatalogObservationReviewDecisionReasonCode,
  type CatalogObservationReviewDecisionReversalInput,
  type CatalogObservationReviewDecisionType,
  type CatalogObservationReviewReversalReasonCode,
  type CatalogObservationReviewItem,
  type CatalogObservationReviewResponse,
} from "../../types/catalogObservationReview";
import { useI18n } from "../../i18n/I18nProvider";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { Button } from "../components/common/Button";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DraggableSurface } from "../components/common/DraggableSurface";
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

type DecisionModalState = {
  mode: "decision";
  reviewItemId: string;
  action: CatalogObservationReviewDecisionType;
  reasonCode: CatalogObservationReviewDecisionReasonCode;
  reviewerNote: string;
  idempotencyKey: string;
};

type ReversalModalState = {
  mode: "reversal";
  reviewItemId: string;
  targetDecisionEventId: string;
  reasonCode: CatalogObservationReviewReversalReasonCode;
  reviewerNote: string;
  idempotencyKey: string;
};

type DecisionAuditEntry = {
  eventId: string;
  label: string;
  reason: string;
  version: number;
  decidedAt: string | null;
  replayed: boolean;
};

type TranslateFn = (path: string, params?: Record<string, string | number>) => string;

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

function badgeToneForDecision(value: string): "neutral" | "success" | "info" | "warning" | "danger" {
  if (value === "ACCEPT_RECOMMENDATION") return "success";
  if (value === "REJECT_RECOMMENDATION") return "danger";
  if (value === "DEFER" || value === "REQUEST_MORE_EVIDENCE") return "warning";
  if (value === "REVERSED" || value === "SUPERSEDED" || value === "INVALIDATED") return "neutral";
  if (value === "STALE") return "warning";
  return "neutral";
}

function createDecisionTypeLabel(value: string, c: TranslateFn) {
  if (value === "ACCEPT_RECOMMENDATION") return c("decision.types.accept");
  if (value === "REJECT_RECOMMENDATION") return c("decision.types.reject");
  if (value === "DEFER") return c("decision.types.defer");
  if (value === "REQUEST_MORE_EVIDENCE") return c("decision.types.requestMoreEvidence");
  if (value === "REVERSED") return c("decision.states.reversed");
  if (value === "SUPERSEDED") return c("decision.states.superseded");
  if (value === "INVALIDATED") return c("decision.states.invalidated");
  if (value === "STALE") return c("decision.states.stale");
  if (value === "UNDECIDED") return c("detail.notDecided");
  return humanizeCode(value);
}

function createDecisionReasonLabel(value: string, c: TranslateFn) {
  const acceptMap: Record<string, string> = {
    EVIDENCE_SUFFICIENT: c("decision.reasons.accept.evidenceSufficient"),
    VERIFIED_AGAINST_CURRENT_PRODUCT: c("decision.reasons.accept.verifiedAgainstCurrentProduct"),
    TRUSTED_OFFICIAL_SOURCE: c("decision.reasons.accept.trustedOfficialSource"),
  };
  const rejectMap: Record<string, string> = {
    INCORRECT_OBSERVATION: c("decision.reasons.reject.incorrectObservation"),
    INSUFFICIENT_EVIDENCE: c("decision.reasons.reject.insufficientEvidence"),
    CONFLICTS_WITH_CANONICAL_DATA: c("decision.reasons.reject.conflictsWithCanonicalData"),
    WRONG_PRODUCT_MATCH: c("decision.reasons.reject.wrongProductMatch"),
    FIELD_NOT_APPLICABLE: c("decision.reasons.reject.fieldNotApplicable"),
  };
  const deferMap: Record<string, string> = {
    NEEDS_SECOND_REVIEW: c("decision.reasons.defer.needsSecondReview"),
    WAITING_FOR_SOURCE_CONFIRMATION: c("decision.reasons.defer.waitingForSourceConfirmation"),
    TEMPORARY_REVIEW_HOLD: c("decision.reasons.defer.temporaryReviewHold"),
  };
  const evidenceMap: Record<string, string> = {
    MISSING_PRIMARY_SOURCE: c("decision.reasons.requestMoreEvidence.missingPrimarySource"),
    CONFLICTING_SOURCES: c("decision.reasons.requestMoreEvidence.conflictingSources"),
    LOW_CONFIDENCE: c("decision.reasons.requestMoreEvidence.lowConfidence"),
    INCOMPLETE_PRODUCT_MATCH: c("decision.reasons.requestMoreEvidence.incompleteProductMatch"),
  };
  const reversalMap: Record<string, string> = {
    DECISION_ENTERED_IN_ERROR: c("decision.reasons.reverse.decisionEnteredInError"),
    NEW_EVIDENCE_RECEIVED: c("decision.reasons.reverse.newEvidenceReceived"),
    RECOMMENDATION_CHANGED: c("decision.reasons.reverse.recommendationChanged"),
    PRODUCT_STATE_CHANGED: c("decision.reasons.reverse.productStateChanged"),
  };

  return (
    acceptMap[value] ||
    rejectMap[value] ||
    deferMap[value] ||
    evidenceMap[value] ||
    reversalMap[value] ||
    humanizeCode(value)
  );
}

function createApplyBlockReasonLabel(value: string, c: TranslateFn) {
  const labels: Record<string, string> = {
    NO_ACCEPT_DECISION: c("decision.blocks.noAcceptDecision"),
    DECISION_REVERSED: c("decision.blocks.decisionReversed"),
    DECISION_SUPERSEDED: c("decision.blocks.decisionSuperseded"),
    DECISION_INVALIDATED: c("decision.blocks.decisionInvalidated"),
    FIELD_POLICY_PROHIBITS_APPLY: c("decision.blocks.fieldPolicyProhibitsApply"),
    RECOMMENDATION_CHANGED: c("decision.blocks.recommendationChanged"),
    REVIEW_ITEM_CHANGED: c("decision.blocks.reviewItemChanged"),
    PRODUCT_TARGET_CHANGED: c("decision.blocks.productTargetChanged"),
  };
  return labels[value] || humanizeCode(value);
}

function createStaleReasonLabel(value: string, c: TranslateFn) {
  const labels: Record<string, string> = {
    RECOMMENDATION_CHANGED: c("decision.staleReasons.recommendationChanged"),
    REVIEW_ITEM_CHANGED: c("decision.staleReasons.reviewItemChanged"),
    PRODUCT_TARGET_CHANGED: c("decision.staleReasons.productTargetChanged"),
  };
  return labels[value] || humanizeCode(value);
}

function humanizeCode(value: string) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createDecisionStateLabel(item: CatalogObservationReviewItem, c: TranslateFn) {
  const state = item.decision_state;
  if (state.is_invalidated) return c("decision.states.invalidated");
  if (state.is_superseded) return c("decision.states.superseded");
  if (state.is_reversed) return c("decision.states.reversed");
  if (state.is_stale) return c("decision.states.stale");
  if (state.current_decision) return createDecisionTypeLabel(state.current_decision, c);
  return c("detail.notDecided");
}

function createDecisionStateTone(item: CatalogObservationReviewItem) {
  const state = item.decision_state;
  if (state.is_invalidated) return "danger" as const;
  if (state.is_superseded || state.is_stale) return "warning" as const;
  if (state.is_reversed) return "neutral" as const;
  return badgeToneForDecision(state.current_decision || "");
}

function createDecisionReasonOptions(action: CatalogObservationReviewDecisionType, c: TranslateFn) {
  const source = CATALOG_OBSERVATION_REVIEW_DECISION_REASON_CODES[action];
  return source.map((value) => ({ value, label: createDecisionReasonLabel(value, c) }));
}

function createReversalReasonOptions(c: TranslateFn) {
  return CATALOG_OBSERVATION_REVIEW_REVERSAL_REASON_CODES.map((value) => ({ value, label: createDecisionReasonLabel(value, c) }));
}

function createDecisionActionOptions(c: TranslateFn) {
  return CATALOG_OBSERVATION_REVIEW_DECISION_TYPES.map((value) => ({ value, label: createDecisionTypeLabel(value, c) }));
}

function createDecisionActionLabel(value: CatalogObservationReviewDecisionType, c: TranslateFn) {
  return createDecisionTypeLabel(value, c);
}

function createDecisionFingerprintComparison(
  label: string,
  decisionValue: string | null,
  currentValue: string | null,
  c: TranslateFn,
) {
  const decisionText = String(decisionValue || "").trim();
  const currentText = String(currentValue || "").trim();
  const mismatch = Boolean(decisionText && currentText && decisionText !== currentText);
  return (
    <div className="catalog-observation-review-fingerprint-comparison">
      <strong>{label}</strong>
      <span>{c("decision.fingerprints.atDecision", { value: decisionText || c("emptyValue.notAvailable") })}</span>
      <span>{c("decision.fingerprints.current", { value: currentText || c("emptyValue.notAvailable") })}</span>
      {mismatch ? <span className="warning-text">{c("decision.fingerprints.changed")}</span> : null}
    </div>
  );
}

function createIdempotencyKey(prefix: string) {
  const uuid = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}:${uuid}`;
}

function decisionHistoryEntryFromCurrentState(item: CatalogObservationReviewItem, c: TranslateFn): DecisionAuditEntry | null {
  const currentEventId = item.decision_state.current_event_id?.trim();
  if (!currentEventId) return null;
  const blockReasons = item.decision_state.apply_block_reasons.length
    ? item.decision_state.apply_block_reasons.map((value) => createApplyBlockReasonLabel(value, c)).join("; ")
    : c("decision.history.applyEligible");
  return {
    eventId: currentEventId,
    label: createDecisionStateLabel(item, c),
    reason: blockReasons,
    version: item.decision_state.decision_version,
    decidedAt: item.decision_state.decided_at,
    replayed: false,
  };
}

function mergeDecisionHistoryEntries(current: DecisionAuditEntry[], next: DecisionAuditEntry) {
  const entries = [next, ...current.filter((entry) => entry.eventId !== next.eventId)];
  return entries.slice(0, 5);
}

export function CatalogObservationReviewPage() {
  const { locale, t } = useI18n();
  const actionFeedback = useActionFeedback();
  const [filters, setFilters] = useState<ReviewFilters>(() => readFiltersFromUrl());
  const [response, setResponse] = useState<CatalogObservationReviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [commandSubmitting, setCommandSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [decisionModal, setDecisionModal] = useState<DecisionModalState | null>(null);
  const [reversalModal, setReversalModal] = useState<ReversalModalState | null>(null);
  const [decisionHistory, setDecisionHistory] = useState<Record<string, DecisionAuditEntry[]>>({});
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
  const selectedItemKey = selectedItem ? itemKey(selectedItem) : "";
  const selectedDecisionState = selectedItem?.decision_state ?? null;
  const hasActiveFilters = Boolean(filters.fieldFamily || filters.comparisonResult || filters.recommendation || filters.cursor);
  const evidenceUrlIsSafe = validHttpUrl(selectedItem?.evidence_url);
  const selectedDecisionHistory = useMemo(() => {
    if (!selectedItem) return [] as DecisionAuditEntry[];
    const currentEntries = decisionHistory[selectedItemKey] || [];
    const currentStateEntry = decisionHistoryEntryFromCurrentState(selectedItem, c);
    const merged = [...currentEntries];
    if (currentStateEntry && !merged.some((entry) => entry.eventId === currentStateEntry.eventId)) {
      merged.push(currentStateEntry);
    }
    return merged.sort((left, right) => {
      const leftTime = left.decidedAt ? new Date(left.decidedAt).getTime() : 0;
      const rightTime = right.decidedAt ? new Date(right.decidedAt).getTime() : 0;
      return rightTime - leftTime;
    });
  }, [c, decisionHistory, selectedItem, selectedItemKey]);
  const decisionTypeOptions = useMemo(() => createDecisionActionOptions(c), [t]);
  const reversalReasonOptions = useMemo(() => createReversalReasonOptions(c), [t]);
  const decisionReasonOptions = useMemo(
    () => (decisionModal ? createDecisionReasonOptions(decisionModal.action, c) : []),
    [c, decisionModal],
  );
  const canRecordDecision = Boolean(selectedItem && selectedDecisionState && !selectedDecisionState.is_stale && !selectedDecisionState.is_invalidated);
  const canReverseDecision = Boolean(
    selectedItem &&
      selectedDecisionState &&
      selectedDecisionState.current_event_id &&
      selectedDecisionState.current_decision &&
      !selectedDecisionState.is_stale &&
      !selectedDecisionState.is_invalidated,
  );
  const staleDecisionReasons = selectedDecisionState
    ? [
        ...(selectedDecisionState.current_recommendation_fingerprint !== selectedDecisionState.recommendation_fingerprint_at_decision
          ? [createStaleReasonLabel("RECOMMENDATION_CHANGED", c)]
          : []),
        ...(selectedDecisionState.current_review_item_fingerprint !== selectedDecisionState.review_item_fingerprint_at_decision
          ? [createStaleReasonLabel("REVIEW_ITEM_CHANGED", c)]
          : []),
        ...(selectedDecisionState.current_product_target_fingerprint !== selectedDecisionState.product_target_fingerprint_at_decision
          ? [createStaleReasonLabel("PRODUCT_TARGET_CHANGED", c)]
          : []),
      ]
    : [];

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
    if (commandSubmitting) return;
    const focusKey = filters.selected;
    closeDecisionDialogs();
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

  useEffect(() => {
    if (!decisionModal && !reversalModal) return;
    if (!selectedItem) {
      closeDecisionDialogs();
      return;
    }
    if (decisionModal && decisionModal.reviewItemId !== selectedItem.review_queue_id) {
      setDecisionModal(null);
    }
    if (reversalModal && reversalModal.reviewItemId !== selectedItem.review_queue_id) {
      setReversalModal(null);
    }
  }, [decisionModal, reversalModal, selectedItem]);

  function handleNextPage() {
    if (!page?.next_cursor) return;
    initialSelectionAppliedRef.current = false;
    setFilters((current) => ({
      ...current,
      cursor: page.next_cursor || "",
      selected: "",
    }));
  }

  function buildDecisionHistoryEntry(result: CatalogObservationReviewDecisionCommandResult): DecisionAuditEntry {
    const actionLabel =
      result.action === "reverse_decision"
        ? c("decision.actions.reverseCurrent")
        : createDecisionTypeLabel(result.event.decision_type || result.current_state.current_decision || "UNDECIDED", c);
    return {
      eventId: result.event.event_id || result.event.review_item_id || createIdempotencyKey("event"),
      label: actionLabel,
      reason: result.event.reason_code ? createDecisionReasonLabel(result.event.reason_code, c) : c("decision.history.noReason"),
      version: result.event.decision_version || result.current_state.decision_version,
      decidedAt: result.event.decided_at,
      replayed: result.replayed,
    };
  }

  function openDecisionModal(action: CatalogObservationReviewDecisionType) {
    if (!selectedItem || !selectedDecisionState || selectedDecisionState.is_stale || selectedDecisionState.is_invalidated) return;
    setReversalModal(null);
    setDecisionModal({
      mode: "decision",
      reviewItemId: selectedItem.review_queue_id,
      action,
      reasonCode: (createDecisionReasonOptions(action, c)[0]?.value || "") as CatalogObservationReviewDecisionReasonCode,
      reviewerNote: "",
      idempotencyKey: createIdempotencyKey(`decision:${action.toLowerCase()}`),
    });
  }

  function openReverseModal() {
    if (!selectedItem || !selectedDecisionState || !selectedDecisionState.current_event_id || selectedDecisionState.is_stale || selectedDecisionState.is_invalidated) return;
    setDecisionModal(null);
    setReversalModal({
      mode: "reversal",
      reviewItemId: selectedItem.review_queue_id,
      targetDecisionEventId: selectedDecisionState.current_event_id,
      reasonCode: CATALOG_OBSERVATION_REVIEW_REVERSAL_REASON_CODES[0],
      reviewerNote: "",
      idempotencyKey: createIdempotencyKey("reverse"),
    });
  }

  function closeDecisionDialogs() {
    setDecisionModal(null);
    setReversalModal(null);
  }

  function requestCloseDecisionDialogs() {
    if (commandSubmitting) return;
    closeDecisionDialogs();
  }

  async function handleSubmitDecision() {
    if (!selectedItem || !decisionModal || !selectedDecisionState) return;
    try {
      setError("");
      setCommandSubmitting(true);
      actionFeedback.begin(c("decision.feedback.recording"));
      const result = await submitCatalogObservationReviewDecision(
        {
          reviewItemId: decisionModal.reviewItemId,
          decisionType: decisionModal.action,
          reasonCode: decisionModal.reasonCode as CatalogObservationReviewDecisionCommandInput["reasonCode"],
          reviewerNote: decisionModal.reviewerNote,
          expectedDecisionVersion: selectedDecisionState.decision_version,
          expectedRecommendationFingerprint: selectedItem.recommendation_fingerprint,
          expectedReviewItemFingerprint: selectedItem.review_item_fingerprint,
          expectedProductTargetFingerprint: selectedItem.product_target_fingerprint,
          idempotencyKey: decisionModal.idempotencyKey,
        },
      );
      setDecisionHistory((current) => ({
        ...current,
        [selectedItemKey]: mergeDecisionHistoryEntries(current[selectedItemKey] || [], buildDecisionHistoryEntry(result)),
      }));
      closeDecisionDialogs();
      setReloadTick((current) => current + 1);
      actionFeedback.succeed(result.replayed ? c("decision.feedback.recordedReplay") : c("decision.feedback.recorded"));
    } catch (caught) {
      const message = sanitizeUserFacingMessage(
        caught instanceof Error ? caught.message : String(caught || ""),
        c("decision.errors.recordFailed"),
      );
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setCommandSubmitting(false);
    }
  }

  async function handleSubmitReversal() {
    if (!selectedItem || !reversalModal || !selectedDecisionState) return;
    try {
      setError("");
      setCommandSubmitting(true);
      actionFeedback.begin(c("decision.feedback.reversing"));
      const payload: CatalogObservationReviewDecisionReversalInput = {
        reviewItemId: reversalModal.reviewItemId,
        targetDecisionEventId: reversalModal.targetDecisionEventId,
        reasonCode: reversalModal.reasonCode,
        reviewerNote: reversalModal.reviewerNote,
        expectedDecisionVersion: selectedDecisionState.decision_version,
        idempotencyKey: reversalModal.idempotencyKey,
      };
      const result = await reverseCatalogObservationReviewDecision(payload);
      setDecisionHistory((current) => ({
        ...current,
        [selectedItemKey]: mergeDecisionHistoryEntries(current[selectedItemKey] || [], buildDecisionHistoryEntry(result)),
      }));
      closeDecisionDialogs();
      setReloadTick((current) => current + 1);
      actionFeedback.succeed(
        result.replayed ? c("decision.feedback.reversedReplay") : c("decision.feedback.reversed"),
      );
    } catch (caught) {
      const message = sanitizeUserFacingMessage(
        caught instanceof Error ? caught.message : String(caught || ""),
        c("decision.errors.reverseFailed"),
      );
      setError(message);
      actionFeedback.fail(message);
    } finally {
      setCommandSubmitting(false);
    }
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
            <Button variant="secondary" onClick={clearFilters} disabled={!hasActiveFilters || refreshing || commandSubmitting}>
              {c("actions.clearFilters")}
            </Button>
            <Button onClick={() => setReloadTick((current) => current + 1)} busy={refreshing} busyLabel={c("actions.refreshing")} disabled={commandSubmitting}>
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
                <DetailRow label={c("detail.decision")} value={createDecisionStateLabel(selectedItem, c)} />
                <DetailRow label={c("decision.labels.version")} value={selectedDecisionState?.decision_version ?? 0} />
                <DetailRow label={c("decision.labels.currentEventId")} value={displayValue(selectedDecisionState?.current_event_id, c("emptyValue.notAvailable"))} />
                <DetailRow
                  label={c("decision.labels.applyEligibility")}
                  value={
                    <StatusBadge tone={selectedDecisionState?.apply_eligible ? "success" : "warning"}>
                      {selectedDecisionState?.apply_eligible ? c("decision.state.applyEligible") : c("decision.state.applyBlocked")}
                    </StatusBadge>
                  }
                />
                <DetailRow
                  label={c("decision.labels.stateFlags")}
                  value={
                    <div className="document-marks document-marks--compact">
                      {selectedDecisionState?.is_stale ? <StatusBadge tone="warning">{c("decision.states.stale")}</StatusBadge> : <StatusBadge tone="neutral">{c("decision.states.current")}</StatusBadge>}
                      {selectedDecisionState?.is_reversed ? <StatusBadge tone="neutral">{c("decision.states.reversed")}</StatusBadge> : null}
                      {selectedDecisionState?.is_superseded ? <StatusBadge tone="warning">{c("decision.states.superseded")}</StatusBadge> : null}
                      {selectedDecisionState?.is_invalidated ? <StatusBadge tone="danger">{c("decision.states.invalidated")}</StatusBadge> : null}
                      {selectedDecisionState?.requires_re_review ? <StatusBadge tone="info">{c("decision.states.requiresReReview")}</StatusBadge> : null}
                    </div>
                  }
                />
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
                <DetailRow
                  label={c("decision.labels.applyBlockReasons")}
                  value={
                    selectedDecisionState?.apply_block_reasons.length
                      ? selectedDecisionState.apply_block_reasons.map((value) => createApplyBlockReasonLabel(value, c)).join("; ")
                      : c("decision.state.applyEligible")
                  }
                />
              </div>

              <div className="catalog-observation-review-decision-panel">
                <div className="toolbar toolbar--wrap">
                  <div>
                    <strong>{c("decision.title")}</strong>
                    <div className="muted-text">{c("decision.subtitle")}</div>
                  </div>
                  <div className="document-marks document-marks--compact">
                    <StatusBadge tone={createDecisionStateTone(selectedItem)}>{createDecisionStateLabel(selectedItem, c)}</StatusBadge>
                    <StatusBadge tone={selectedDecisionState?.apply_eligible ? "success" : "warning"}>
                      {selectedDecisionState?.apply_eligible ? c("decision.state.applyEligible") : c("decision.state.applyBlocked")}
                    </StatusBadge>
                  </div>
                </div>

                {selectedDecisionState?.is_stale ? (
                  <div className="warning-text">
                    {c("decision.warnings.stale", {
                      reasons: staleDecisionReasons.length ? staleDecisionReasons.join("; ") : c("decision.warnings.staleFallback"),
                    })}
                  </div>
                ) : null}

                {!selectedDecisionState?.apply_eligible ? (
                  <div className="info-text">
                    {selectedDecisionState?.apply_block_reasons.length
                      ? c("decision.applyBlocked", {
                          reasons: selectedDecisionState.apply_block_reasons.map((value) => createApplyBlockReasonLabel(value, c)).join("; "),
                        })
                      : c("decision.applyEligibleHint")}
                  </div>
                ) : (
                  <div className="info-text">{c("decision.applyEligibleHint")}</div>
                )}

                <div className="toolbar toolbar--wrap">
                  {decisionTypeOptions.map((option) => (
                    <Button
                      key={option.value}
                      variant="secondary"
                      className="button--compact"
                      onClick={() => openDecisionModal(option.value)}
                      disabled={!canRecordDecision || commandSubmitting}
                    >
                      {option.label}
                    </Button>
                  ))}
                  {canReverseDecision ? (
                    <Button variant="secondary" className="button--compact" onClick={openReverseModal} disabled={commandSubmitting}>
                      {c("decision.actions.reverseCurrent")}
                    </Button>
                  ) : null}
                </div>

                <div className="catalog-observation-review-history">
                  <strong>{c("decision.history.title" )}</strong>
                  {selectedDecisionHistory.length ? (
                    selectedDecisionHistory.map((entry) => (
                      <div key={entry.eventId} className="catalog-observation-review-history-entry">
                        <div className="document-marks document-marks--compact">
                          <StatusBadge tone={entry.replayed ? "info" : "neutral"}>{entry.label}</StatusBadge>
                          <StatusBadge tone="neutral">{c("decision.history.version", { version: entry.version })}</StatusBadge>
                          {entry.replayed ? <StatusBadge tone="info">{c("decision.history.replayed")}</StatusBadge> : null}
                        </div>
                        <span className="muted-text">
                          {entry.decidedAt ? formatDate(entry.decidedAt, locale, c("emptyValue.notAvailable")) : c("decision.history.notRecorded")}
                        </span>
                        <span>{entry.reason}</span>
                        <code>{entry.eventId}</code>
                      </div>
                    ))
                  ) : (
                    <span className="muted-text">{c("decision.history.empty")}</span>
                  )}
                </div>
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

      {decisionModal && selectedItem ? (
        <div className="modal-backdrop" onClick={requestCloseDecisionDialogs}>
          <DraggableSurface className="modal-card modal-card--compact" dragHandleSelector=".draggable-surface__handle" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>{c("decision.modal.title", { action: createDecisionActionLabel(decisionModal.action, c) })}</h3>
                <p>{c("decision.modal.description")}</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <div className="info-text">
                <strong>{emptyDash(selectedItem.product_code)}</strong>
                <div>{displayValue(selectedItem.brand_name, c("emptyValue.notAvailable"))}</div>
                <div>{c("decision.modal.summaryState", { state: createDecisionStateLabel(selectedItem, c), version: selectedDecisionState?.decision_version ?? 0 })}</div>
                <div>{c("decision.modal.summaryRecommendation", { recommendation: recommendationLabel(selectedItem.recommendation, c) })}</div>
                <div>{c("decision.modal.summaryApplyEligibility", { status: selectedDecisionState?.apply_eligible ? c("decision.state.applyEligible") : c("decision.state.applyBlocked") })}</div>
              </div>
              <Select
                label={c("decision.modal.reason")}
                value={decisionModal.reasonCode}
                options={decisionReasonOptions}
                onChange={(value) => setDecisionModal((current) => (current ? { ...current, reasonCode: value as CatalogObservationReviewDecisionReasonCode } : current))}
                disabled={commandSubmitting}
              />
              <label className="field">
                <span className="field__label">{c("decision.modal.note")}</span>
                <textarea
                  className="field__input field__input--textarea"
                  value={decisionModal.reviewerNote}
                  placeholder={c("decision.modal.notePlaceholder")}
                  disabled={commandSubmitting}
                  onChange={(event) => setDecisionModal((current) => (current ? { ...current, reviewerNote: event.target.value } : current))}
                />
              </label>
            </div>
            {selectedDecisionState?.is_stale ? <div className="warning-text">{c("decision.warnings.modalStale")}</div> : null}
            <div className="modal-hint">{c("decision.modal.confirmationHint")}</div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={requestCloseDecisionDialogs} disabled={commandSubmitting}>
                {c("decision.modal.cancel")}
              </Button>
              <Button onClick={() => void handleSubmitDecision()} busy={commandSubmitting} busyLabel={c("decision.modal.confirming")}>
                {c("decision.modal.confirm")}
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}

      {reversalModal && selectedItem ? (
        <div className="modal-backdrop" onClick={requestCloseDecisionDialogs}>
          <DraggableSurface className="modal-card modal-card--compact" dragHandleSelector=".draggable-surface__handle" onClick={(event) => event.stopPropagation()}>
            <div className="modal-card__header draggable-surface__handle">
              <div>
                <h3>{c("decision.modal.reverseTitle")}</h3>
                <p>{c("decision.modal.reverseDescription")}</p>
              </div>
            </div>
            <div className="modal-form-grid">
              <div className="info-text">
                <strong>{emptyDash(selectedItem.product_code)}</strong>
                <div>{displayValue(selectedItem.brand_name, c("emptyValue.notAvailable"))}</div>
                <div>{c("decision.modal.reverseSummary", { state: createDecisionStateLabel(selectedItem, c), eventId: selectedDecisionState?.current_event_id || c("emptyValue.notAvailable") })}</div>
              </div>
              <Select
                label={c("decision.modal.reason")}
                value={reversalModal.reasonCode}
                options={reversalReasonOptions}
                onChange={(value) => setReversalModal((current) => (current ? { ...current, reasonCode: value as CatalogObservationReviewReversalReasonCode } : current))}
                disabled={commandSubmitting}
              />
              <label className="field">
                <span className="field__label">{c("decision.modal.note")}</span>
                <textarea
                  className="field__input field__input--textarea"
                  value={reversalModal.reviewerNote}
                  placeholder={c("decision.modal.notePlaceholder")}
                  disabled={commandSubmitting}
                  onChange={(event) => setReversalModal((current) => (current ? { ...current, reviewerNote: event.target.value } : current))}
                />
              </label>
            </div>
            <div className="modal-hint">{c("decision.modal.reverseHint")}</div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={requestCloseDecisionDialogs} disabled={commandSubmitting}>
                {c("decision.modal.cancel")}
              </Button>
              <Button onClick={() => void handleSubmitReversal()} busy={commandSubmitting} busyLabel={c("decision.modal.reversing")}>
                {c("decision.modal.reverseConfirm")}
              </Button>
            </div>
          </DraggableSurface>
        </div>
      ) : null}
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
