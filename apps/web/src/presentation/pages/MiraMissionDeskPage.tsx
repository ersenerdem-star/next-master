import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PageHeader, PageShell, StatusBadge } from "../components/common/VisualPrimitives";
import { useI18n } from "../../i18n/I18nProvider";
import { clearQueuedMiraMissions, hideMiraMissions, listMiraMissions, planMiraMissions, queueMiraMission, reviewMiraMission, type MiraMission } from "../../infrastructure/api/miraMissionsApi";

type MiraDeskTab = "queue" | "evidence" | "results";

const MIRA_FIELDS = [
  ["description", "Description"],
  ["oem", "OEM"],
  ["ean", "EAN"],
  ["tariff", "Tariff / HS code"],
  ["vehicle", "Vehicle"],
  ["vehicle_model", "Vehicle model"],
  ["dimensions", "Dimensions"],
  ["weight", "Weight"],
  ["image", "Image"],
] as const;

type MissionReport = {
  evidence: unknown;
  summary: string | null;
  negativeReason: string | null;
  artifactPath: string | null;
  artifactUrl: string | null;
  debriefPath: string | null;
  debriefUrl: string | null;
  resultStatus: string | null;
  lifecycle: string | null;
  pagesObserved: number | null;
  candidates: number | null;
  authorityDecisionRequired: boolean | null;
  guarantees: {
    credentialsIncluded: boolean | null;
    catalogWrite: boolean | null;
    apply: boolean | null;
    automaticAuthorityExpansion: boolean | null;
  };
  knowledgeGaps: unknown;
  learning: unknown;
  authorityFindings: unknown;
  package: {
    requested: number | null;
    observed: number | null;
    failed: number | null;
    staged: number | null;
    loaded: number | null;
    alreadyPresent: number | null;
    guarded: number | null;
    deduped: number | null;
    skipped: number | null;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function firstReason(...values: unknown[]): string | null {
  for (const value of values) {
    if (Array.isArray(value)) {
      const reasons = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim());
      if (reasons.length > 0) return reasons.join("; ");
    }
    const text = firstText(value);
    if (text) return text;
  }
  return null;
}

function readRecordValue(records: Record<string, unknown>[], ...keys: string[]): unknown {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }
  return undefined;
}

function readNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return null;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return /^https:\/\//i.test(candidate) ? candidate : null;
}

function safeDisplayReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || /^(?:\/|~\/|file:|[A-Za-z]:[\\/])/i.test(candidate)) return null;
  return candidate.length > 300 ? `${candidate.slice(0, 300)}…` : candidate;
}

function displayReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  if (/^(?:\/|~\/|file:|[A-Za-z]:[\\/])/i.test(candidate)) {
    const parts = candidate.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  }
  return safeDisplayReference(candidate);
}

function compactValue(value: unknown, maxLength = 420): string | null {
  const text = firstText(value) ?? (value == null ? null : (() => {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  })());
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function reportForMission(mission: MiraMission): MissionReport {
  const root = asRecord(mission.result);
  const result = root ?? {};
  const debrief = asRecord(result.debrief) ?? asRecord(result.mission_debrief);
  const handoff = asRecord(result.handoff) ?? asRecord(result.mission_debrief_handoff);
  const paths = asRecord(result.paths);
  const guarantees = asRecord(result.guarantees) ?? {};
  const authority = asRecord(result.authority);
  const intake = asRecord(result.observationIntake) ?? asRecord(result.observation_intake);
  const nested = [result, debrief, handoff, authority].filter((value): value is Record<string, unknown> => Boolean(value));
  const read = (...keys: string[]) => readRecordValue(nested, ...keys);
  const pagesObserved = readNumber(read("pagesObserved", "pages_observed", "pageCount", "page_count"));
  const candidates = readNumber(read("eanCandidates", "ean_candidates", "candidateCount", "candidate_count", "observationCount", "observation_count"));
  const resultStatus = firstText(mission.status, read("status", "resultStatus", "result_status", "outcome"));
  const lifecycle = firstText(read("lifecycle", "phase"));
  const authorityDecisionRequired = readBoolean(read("authorityDecisionRequired", "authority_decision_required"));
  const explicitEvidence = read("evidence", "observations", "observation_count", "observed_count", "evidence_count");
  const evidence = explicitEvidence ?? {
    pagesObserved: pagesObserved ?? 0,
    candidates: candidates ?? 0,
    authorityDecisionRequired: authorityDecisionRequired ?? false,
  };
  const explicitSummary = firstText(read("result_summary", "resultSummary", "summary", "message"));
  const summary = explicitSummary ?? (
    resultStatus === "blocked"
      ? "Görev güvenli şekilde durduruldu; kaynak veya yetki koşulu karşılanmadı."
      : resultStatus === "queued" || resultStatus === "processing"
        ? "Görev henüz tamamlanmadı."
        : candidates === 0
          ? "Görev çalıştı ancak doğrulanmış aday bulamadı."
          : `Görev tamamlandı; ${candidates} doğrulanmış aday bulundu.`
  );
  const explicitNegative = firstReason(
    mission.error_message,
    read("noResultReason", "no_result_reason", "negative_result_reason", "negativeResultReason", "negative_reason", "negativeReason", "failure_reason", "failureReason", "reason"),
    read("negativeReasons", "negative_reasons"),
    read("knowledgeGaps", "knowledge_gaps"),
  );
  const negativeReason = explicitNegative ?? (
    candidates === 0 && resultStatus !== "queued" && resultStatus !== "processing"
      ? "Doğrulanmış katalog adayı bulunmadı; kaynak çıktısı kanıt için yetersiz kaldı."
      : null
  );
  const requested = readNumber(mission.max_items, read("requestedCount", "requested_count", "requested"));
  const observed = readNumber(read("observedCount", "observed_count", "observed", "observationCount", "observation_count"), intake?.observedCount, intake?.observed_count);
  const staged = readNumber(intake?.stagedCount, intake?.staged_count, intake?.observationsAppended, intake?.observations_appended, intake?.observedCount, intake?.observed_count);
  const loaded = readNumber(read("publishedInserted", "published_inserted", "catalogProductsWritten", "catalog_products_written", "insertedCount", "inserted_count"), intake?.publishedInserted, intake?.published_inserted, intake?.catalogProductsWritten, intake?.catalog_products_written);
  const alreadyPresent = readNumber(read("alreadyPresent", "already_present", "dedupedCount", "deduped_count"), intake?.alreadyPresent, intake?.already_present);
  const guarded = readNumber(read("guardedEnrichment", "guarded_enrichment", "guardedCount", "guarded_count"), intake?.guardedEnrichment, intake?.guarded_enrichment);
  const deduped = readNumber(intake?.dedupedCount, intake?.deduped_count, intake?.observationsDeduped, intake?.observations_deduped);
  const skipped = readNumber(read("skippedCount", "skipped_count", "skipped"), intake?.skippedCount, intake?.skipped_count);
  const failed = readNumber(read("failedCount", "failed_count", "failed"), skipped, requested !== null && observed !== null ? Math.max(requested - observed, 0) : null);

  return {
    evidence,
    summary,
    negativeReason,
    artifactPath: displayReference(
      read("discoveryArtifactPath", "discovery_artifact_path", "artifact_path", "artifactPath", "artifact_uri", "artifactUri")
      ?? paths?.discoveryArtifactPath ?? paths?.discovery_artifact_path ?? paths?.artifact
    ),
    artifactUrl: safeHttpUrl(read("artifact_url", "artifactUrl", "evidence_url", "evidenceUrl") ?? paths?.artifactUrl ?? paths?.artifact_url),
    debriefPath: displayReference(
      read("debrief_path", "debriefPath", "mission_debrief_path", "missionDebriefPath")
      ?? paths?.debrief ?? paths?.missionDebrief ?? paths?.mission_debrief
      ?? (debrief?.debriefFingerprint ? `fingerprint:${String(debrief.debriefFingerprint)}` : null)
    ),
    debriefUrl: safeHttpUrl(read("debrief_url", "debriefUrl", "mission_debrief_url", "missionDebriefUrl") ?? paths?.debriefUrl ?? paths?.debrief_url),
    resultStatus,
    lifecycle,
    pagesObserved,
    candidates,
    authorityDecisionRequired,
    guarantees: {
      credentialsIncluded: readBoolean(guarantees.credentialsIncluded, guarantees.credentials_included, read("credentialsIncluded", "credentials_included")),
      catalogWrite: readBoolean(guarantees.catalogWrite, guarantees.catalog_write, read("catalogWrite", "catalog_write")),
      apply: readBoolean(guarantees.apply, read("apply")),
      automaticAuthorityExpansion: readBoolean(guarantees.automaticAuthorityExpansion, guarantees.automatic_authority_expansion, read("automaticAuthorityExpansion", "automatic_authority_expansion")),
    },
    knowledgeGaps: read("knowledgeGaps", "knowledge_gaps"),
    learning: read("researchLearning", "research_learning", "learning", "lessons"),
    authorityFindings: authority?.findings ?? read("authorityFindings", "authority_findings", "findings"),
    package: { requested, observed, failed, staged, loaded, alreadyPresent, guarded, deduped, skipped },
  };
}

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "blocked") return "danger";
  if (status === "cancelled") return "neutral";
  return "warning";
}

function ArtifactReference({ label, path, url }: { label: string; path: string | null; url: string | null }) {
  if (!path && !url) return <p className="mira-mission-page__artifact-empty">{label}: henüz eklenmedi.</p>;
  return (
    <div className="mira-mission-page__artifact">
      <span>{label}</span>
      {url ? <a href={url} target="_blank" rel="noreferrer">Aç</a> : null}
      {path ? <code>{path}</code> : null}
    </div>
  );
}

function MissionReportCard({ mission, report, evidenceLabel, reasonLabel, artifactLabel, debriefLabel, pendingLabel, onReview }: {
  mission: MiraMission;
  report: MissionReport;
  evidenceLabel: string;
  reasonLabel: string;
  artifactLabel: string;
  debriefLabel: string;
  pendingLabel: string;
  onReview: (mission: MiraMission, decision: "approved" | "rejected") => void;
}) {
  const evidenceText = compactValue(report.evidence);
  const summaryText = report.summary || "Sonuç özeti henüz dönmedi.";
  const statusText = report.resultStatus || mission.status;
  const safetyItems = [
    report.guarantees.credentialsIncluded === false ? "Kimlik bilgisi göndermedi" : null,
    report.guarantees.catalogWrite === false ? "Catalog'a yazmadı" : null,
    report.guarantees.apply === false ? "Apply yapmadı" : null,
    report.guarantees.automaticAuthorityExpansion === false ? "Yetkiyi genişletmedi" : null,
  ].filter(Boolean).join(" · ");
  const listText = (value: unknown) => compactValue(value, 600);
  const reviewStatus = mission.catalog_review_status || "pending";
  const canReview = ["completed", "partial", "blocked", "failed", "cancelled"].includes(mission.status) && reviewStatus === "pending";
  return (
    <article className="mira-mission-page__report-card">
      <div className="mira-mission-page__report-heading">
        <div>
          <strong>{mission.objective}</strong>
          <small>{mission.mission_area} · {new Date(mission.created_at).toLocaleString()}</small>
        </div>
        <StatusBadge tone={statusTone(statusText)}>{statusText}{report.lifecycle ? ` · ${report.lifecycle}` : ""}</StatusBadge>
      </div>
      <div className="mira-mission-page__result-overview">
        <strong>MIRA ne yaptı?</strong>
        <div className="mira-mission-page__result-metrics">
          <span>Sayfa gözlendi: <b>{report.pagesObserved ?? "—"}</b></span>
          <span>Aday: <b>{report.candidates ?? "—"}</b></span>
          <span>Yetki kararı: <b>{report.authorityDecisionRequired === true ? "Gerekli" : report.authorityDecisionRequired === false ? "Gerekli değil" : "—"}</b></span>
        </div>
      </div>
      <div className="mira-mission-page__package-summary" aria-label="Paket sonucu">
        <span>Paket: <b>{report.package.requested ?? "—"}</b></span>
        <span>Gözlenen: <b>{report.package.observed ?? "—"}</b></span>
        <span>Staging: <b>{report.package.staged ?? "—"}</b></span>
        <span>Kataloğa yazılan: <b>{report.package.loaded ?? 0}</b></span>
        <span>Yüklenmeyen: <b>{report.package.failed ?? "—"}</b></span>
        {report.package.alreadyPresent !== null ? <span>Mevcut: <b>{report.package.alreadyPresent}</b></span> : null}
        {report.package.guarded !== null ? <span>Guarded: <b>{report.package.guarded}</b></span> : null}
        {report.package.deduped !== null ? <span>Tekrar: <b>{report.package.deduped}</b></span> : null}
      </div>
      <div className="mira-mission-page__catalog-review-gate">
        <div><strong>Kataloğa aktarım kararı</strong><small>{reviewStatus === "approved" ? "Onaylandı — kontrollü Catalog Review / Apply adımını bekliyor." : reviewStatus === "rejected" ? "Reddedildi — bu paketin katalog yazımı yapılmayacak." : "Bu aday veriyi içeri almak için onay verin veya reddedin."}</small></div>
        {canReview ? <div className="mira-mission-page__review-actions"><button className="button button--primary" type="button" onClick={() => onReview(mission, "approved")}>İçeri almayı onayla</button><button className="button button--secondary" type="button" onClick={() => onReview(mission, "rejected")}>Reddet</button></div> : null}
        {mission.catalog_review_note ? <small>Not: {mission.catalog_review_note}</small> : null}
      </div>
      {mission.status === "failed" || report.negativeReason || report.candidates === 0 ? (
        <div className="mira-mission-page__negative-result" role="status">
          <strong>{reasonLabel}</strong>
          <span>{report.negativeReason || "Görev sonuç üretmedi; worker bir neden döndürmedi."}</span>
        </div>
      ) : null}
      <p className="mira-mission-page__report-summary"><strong>Sonuç:</strong> {summaryText}</p>
      <div className="mira-mission-page__write-preview"><strong>İçeriye yazılacak alanlar</strong><span>{mission.requested_fields?.length ? mission.requested_fields.join(" · ") : "MIRA talimattan çıkaracak"}</span><small>Gerçek yazım, doğrulama ve güvenlik kontrollerinden sonra worker tarafından yapılır.</small></div>
      {evidenceText ? <div className="mira-mission-page__evidence-value"><strong>{evidenceLabel}</strong><code>{evidenceText}</code></div> : <p className="mira-mission-page__artifact-empty">{mission.status === "queued" || mission.status === "processing" ? pendingLabel : `${evidenceLabel}: henüz kanıt yok.`}</p>}
      {safetyItems ? <div className="mira-mission-page__safety-result"><strong>MIRA ne yapmadı?</strong><span>{safetyItems}</span></div> : null}
      <details className="mira-mission-page__report-details"><summary>Kanıt ve debrief ayrıntıları</summary>
        {listText(report.knowledgeGaps) ? <div className="mira-mission-page__report-detail"><strong>Açık kalan konu</strong><span>{listText(report.knowledgeGaps)}</span></div> : null}
        {listText(report.learning) ? <div className="mira-mission-page__report-detail"><strong>Öğrenilen</strong><span>{listText(report.learning)}</span></div> : null}
        {listText(report.authorityFindings) ? <div className="mira-mission-page__report-detail"><strong>Yetki / kaynak bulgusu</strong><span>{listText(report.authorityFindings)}</span></div> : null}
        <div className="mira-mission-page__artifact-grid">
          <ArtifactReference label={artifactLabel} path={report.artifactPath} url={report.artifactUrl} />
          <ArtifactReference label={debriefLabel} path={report.debriefPath} url={report.debriefUrl} />
        </div>
      </details>
    </article>
  );
}

export function MiraMissionDeskPage() {
  const { t } = useI18n();
  const [missions, setMissions] = useState<MiraMission[]>([]);
  const [activeTab, setActiveTab] = useState<MiraDeskTab>("queue");
  const [objective, setObjective] = useState("");
  const [missionArea, setMissionArea] = useState("Public catalog signal");
  const [maxPages, setMaxPages] = useState(1);
  const [delayMs, setDelayMs] = useState(2000);
  const [targetBrand, setTargetBrand] = useState("");
  const [sourceKey, setSourceKey] = useState("mira_auto");
  const [requestedFields, setRequestedFields] = useState<string[]>(["description", "oem", "ean", "image"]);
  const [maxItems, setMaxItems] = useState(25);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [selectedMissionIds, setSelectedMissionIds] = useState<string[]>([]);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  async function refresh({ silent = false }: { silent?: boolean } = {}) {
    if (!silent) setLoading(true);
    try {
      const nextMissions = await listMiraMissions();
      setMissions(nextMissions);
      const queuedIds = new Set(nextMissions.filter((mission) => mission.status === "queued").map((mission) => mission.id));
      setSelectedMissionIds((current) => current.filter((id) => queuedIds.has(id)));
      const historyIds = new Set(nextMissions.filter((mission) => mission.status !== "queued" && mission.status !== "processing").map((mission) => mission.id));
      setSelectedHistoryIds((current) => current.filter((id) => historyIds.has(id)));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA online status could not be loaded.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function hideHistory() {
    if (!selectedHistoryIds.length) return;
    if (!window.confirm(`${selectedHistoryIds.length} seçili MIRA geçmiş kaydı gizlensin mi? Kayıtlar silinmez, yalnızca bu masadan kaldırılır.`)) return;
    setClearing(true);
    try {
      const result = await hideMiraMissions(selectedHistoryIds);
      await refresh({ silent: true });
      setSelectedHistoryIds([]);
      setMessage(`${result.hiddenCount ?? 0} geçmiş kayıt masadan gizlendi.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA geçmişi gizlenemedi.");
    } finally {
      setClearing(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const hasActiveMission = missions.some((mission) => mission.status === "queued" || mission.status === "processing");
  useEffect(() => {
    if (!hasActiveMission) return undefined;
    const timer = window.setInterval(() => { void refresh({ silent: true }); }, 8000);
    return () => window.clearInterval(timer);
  }, [hasActiveMission]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await queueMiraMission({ objective, missionArea, maxPages, delayMs, targetBrand, sourceKey, requestedFields, maxItems });
      if (result.mission) setMissions((items) => [result.mission, ...items]);
      setObjective("");
      setTargetBrand("");
      setActiveTab("queue");
      setMessage("Görev MIRA kuyruğuna alındı. Kaynak seçimi, çalışma ve kanıt dönüşü otomatik ilerleyecek.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA görevi kuyruğa alınamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  async function runPlanner() {
    setPlanning(true);
    try {
      const result = await planMiraMissions();
      await refresh({ silent: true });
      setActiveTab("queue");
      setMessage(result.mission
        ? "MIRA sıradaki işi seçti; görev worker kuyruğuna alındı."
        : "MIRA planlayıcısı çalıştı; uygun yeni görev bulunmadı.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA planlayıcısı çalıştırılamadı.");
    } finally {
      setPlanning(false);
    }
  }

  async function clearQueue() {
    if (!selectedMissionIds.length) return;
    if (!window.confirm(`${selectedMissionIds.length} seçili MIRA görevi iptal edilsin mi? Çalışan görevler etkilenmez.`)) return;
    setClearing(true);
    try {
      const result = await clearQueuedMiraMissions(selectedMissionIds);
      await refresh({ silent: true });
      setSelectedMissionIds([]);
      setMessage(`${result.clearedCount ?? 0} bekleyen görev temizlendi.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA kuyruğu temizlenemedi.");
    } finally {
      setClearing(false);
    }
  }

  async function reviewMission(mission: MiraMission, decision: "approved" | "rejected") {
    const label = decision === "approved" ? "kataloga aktarım" : "paket reddi";
    if (!window.confirm(`${mission.target_brand || "Bu görev"} için ${label} onaylansın mı?`)) return;
    try {
      const response = await reviewMiraMission(mission.id, decision);
      if (response.mission) setMissions((items) => items.map((item) => item.id === mission.id ? { ...item, ...response.mission } : item));
      setMessage(response.handoff?.nextStep || `${label} kaydedildi.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA review kararı kaydedilemedi.");
    }
  }

  const evidenceMissions = useMemo(
    () => missions.filter((mission) => mission.status !== "queued" || Boolean(mission.result) || Boolean(mission.error_message)),
    [missions],
  );
  const terminalMissions = useMemo(
    () => missions.filter((mission) => ["completed", "partial", "blocked", "failed", "cancelled"].includes(mission.status)),
    [missions],
  );
  const deskStatus = missions.some((mission) => mission.status === "processing")
    ? "MIRA çalışıyor"
    : missions.some((mission) => mission.status === "queued")
      ? "Görev bekliyor"
      : "Online";
  const tabs: Array<{ id: MiraDeskTab; label: string; count: number }> = [
    { id: "queue", label: t("mira.missionDesk.tabs.queue"), count: missions.length },
    { id: "evidence", label: t("mira.missionDesk.tabs.evidence"), count: evidenceMissions.length },
    { id: "results", label: t("mira.missionDesk.tabs.results"), count: terminalMissions.length },
  ];
  const queuedMissions = missions.filter((mission) => mission.status === "queued");
  const allQueuedSelected = queuedMissions.length > 0 && queuedMissions.every((mission) => selectedMissionIds.includes(mission.id));
  const historyMissions = missions.filter((mission) => mission.status !== "queued" && mission.status !== "processing");
  const allHistorySelected = historyMissions.length > 0 && historyMissions.every((mission) => selectedHistoryIds.includes(mission.id));

  return (
    <PageShell className="mira-mission-page">
      <PageHeader
        eyebrow={t("mira.missionDesk.eyebrow")}
        title={t("mira.missionDesk.title")}
        subtitle={t("mira.missionDesk.subtitle")}
        status={<StatusBadge tone={deskStatus === "MIRA çalışıyor" ? "warning" : "success"}>{deskStatus}</StatusBadge>}
        actions={<div className="mira-mission-page__header-actions"><button className="button button--primary" type="button" onClick={() => void runPlanner()} disabled={planning || loading}>{planning ? "Planlanıyor…" : "MIRA sıradaki işi seçsin"}</button><button className="button button--secondary" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>}
      />

      <section className="mira-mission-page__hero" aria-labelledby="mira-mission-copy">
        <div className="mira-mission-page__visual" aria-hidden="true"><img src="/mira/mira-home.png" alt="" /><span className="mira-mission-page__glow" /></div>
        <div className="mira-mission-page__copy">
          <h2 id="mira-mission-copy">MIRA online görev masası</h2>
          <p>Görevi yaz. MIRA hedef markayı, aranacak alanı ve uygun kaynağı kendi çıkarır; sonucu kanıt ve debrief olarak geri getirir.</p>
          <div className="mira-mission-page__status-grid" aria-label="MIRA runtime status">
            <div><span>Worker</span><strong>{deskStatus}</strong></div>
            <div><span>Kuyruk</span><strong>{missions.length} görev</strong></div>
            <div><span>Kanıt</span><strong>{evidenceMissions.length} kayıt</strong></div>
            <div><span>Guard</span><strong>Review-only</strong></div>
          </div>
          <div className="mira-mission-page__boundary"><strong>Catalog’a otomatik Apply yok.</strong><span> Kanıt staging’e gelir; final karar ayrı review akışındadır.</span></div>
          <div className="mira-mission-page__workflow" aria-label="MIRA çalışma aşamaları"><span className="is-active"><b>1</b> Görevi tanımla</span><span><b>2</b> Rakamlarla izle</span><span><b>3</b> Yazılacak veriyi gör</span></div>
        </div>
      </section>

      <nav className="mira-mission-page__tabs" aria-label={t("mira.missionDesk.tabs.label")} role="tablist">
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} className={activeTab === tab.id ? "is-active" : ""} onClick={() => setActiveTab(tab.id)}>
            <span>{tab.label}</span><small>{tab.count}</small>
          </button>
        ))}
      </nav>

      {activeTab === "queue" ? (
        <section className="mira-mission-page__online-grid" role="tabpanel">
          <form className="mira-mission-page__online-form" onSubmit={submit}>
            <h2>Yeni online görev</h2>
            <label>Görev talimatı<textarea value={objective} onChange={(event) => setObjective(event.target.value)} minLength={8} maxLength={500} placeholder="Örn. Corteco için eksik OEM ve görselleri bul" rows={3} required /></label>
            <div className="mira-mission-page__form-row"><label>Hedef marka<input value={targetBrand} onChange={(event) => setTargetBrand(event.target.value)} placeholder="Örn. Corteco" /></label><label>Kaynak<select value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}><option value="mira_auto">MIRA otomatik seçsin</option><option value="tecalliance">TecAlliance resmi</option><option value="spareto">Spareto liste kaynağı</option></select></label></div>
            <fieldset className="mira-mission-page__field-picker"><legend>Kontrol edilecek alanlar</legend><div>{MIRA_FIELDS.map(([value, label]) => <label key={value}><input type="checkbox" checked={requestedFields.includes(value)} onChange={(event) => setRequestedFields((current) => event.target.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value))} />{label}</label>)}</div></fieldset>
            <div className="mira-mission-page__form-row"><label>Paket boyutu<input type="number" min="1" max="1000" value={maxItems} onChange={(event) => setMaxItems(Number(event.target.value))} /></label><label>İstek aralığı (ms)<input type="number" min="1000" max="10000" step="100" value={delayMs} onChange={(event) => setDelayMs(Number(event.target.value))} /></label></div>
            <p className="mira-mission-page__form-hint">MIRA önce kanıt/staging üretir. Yazılacak alanlar 3. aşamadaki sonuç ekranında ayrı gösterilir.</p>
            <button className="button button--primary" type="submit" disabled={submitting}>{submitting ? "Kuyruğa alınıyor…" : "MIRA’ya görev ver"}</button>
            {message ? <p className="mira-mission-page__message" role="status">{message}</p> : null}
          </form>
          <section className="mira-mission-page__online-queue" aria-label="MIRA mission queue"><div className="mira-mission-page__queue-header"><div><h2>Online görev kuyruğu</h2><span>{missions.length} kayıt</span></div><div className="mira-mission-page__queue-actions"><label className="mira-mission-page__select-all"><input type="checkbox" checked={allQueuedSelected} onChange={(event) => setSelectedMissionIds(event.target.checked ? queuedMissions.map((mission) => mission.id) : [])} disabled={!queuedMissions.length} />Tüm bekleyenleri seç</label><button className="button button--secondary mira-mission-page__clear-queue" type="button" onClick={() => void clearQueue()} disabled={clearing || !selectedMissionIds.length}>{clearing ? "Siliniyor…" : "Seçilenleri sil"}</button><label className="mira-mission-page__select-all"><input type="checkbox" checked={allHistorySelected} onChange={(event) => setSelectedHistoryIds(event.target.checked ? historyMissions.map((mission) => mission.id) : [])} disabled={!historyMissions.length} />Tüm geçmişi seç</label><button className="button button--secondary mira-mission-page__clear-queue" type="button" onClick={() => void hideHistory()} disabled={clearing || !selectedHistoryIds.length}>{clearing ? "Gizleniyor…" : "Geçmişten gizle"}</button></div></div>{missions.length === 0 && !loading ? <p>Henüz online görev yok.</p> : missions.map((mission) => <article key={mission.id} className="mira-mission-page__queue-item"><label className="mira-mission-page__queue-check"><input type="checkbox" checked={mission.status === "queued" ? selectedMissionIds.includes(mission.id) : selectedHistoryIds.includes(mission.id)} onChange={(event) => { const setter = mission.status === "queued" ? setSelectedMissionIds : setSelectedHistoryIds; setter((current) => event.target.checked ? [...new Set([...current, mission.id])] : current.filter((id) => id !== mission.id)); }} disabled={mission.status === "processing"} aria-label={`${mission.objective} görevini seç`} /></label><div><div className="mira-mission-page__queue-title"><strong>{mission.objective}</strong>{mission.origin === "planner" ? <span className="mira-mission-page__planner-badge">Planner</span> : null}</div><small>{mission.target_brand || "Marka otomatik"} · {mission.planner_context?.sourceKey === "tecalliance" ? "TecAlliance" : mission.planner_context?.sourceKey === "spareto" ? "Spareto" : "MIRA kaynak seçimi"} · {mission.max_items ?? mission.max_pages} ürün</small><small>Alanlar: {(mission.requested_fields || []).join(", ") || "talimattan çıkarılacak"}</small>{mission.origin === "planner" && mission.planner_reason ? <small className="mira-mission-page__planner-reason">{mission.target_brand ?? "Marka"}: {mission.planner_reason}</small> : null}</div><StatusBadge tone={statusTone(mission.status)}>{mission.status}</StatusBadge></article>)}</section>
        </section>
      ) : null}

      {activeTab === "evidence" ? (
        <section className="mira-mission-page__report-panel" role="tabpanel" aria-label={t("mira.missionDesk.tabs.evidence")}>
          <div className="mira-mission-page__panel-heading"><div><h2>{t("mira.missionDesk.evidence.title")}</h2><p>{t("mira.missionDesk.evidence.subtitle")}</p></div><StatusBadge tone="info">Review-only</StatusBadge></div>
          {message ? <p className="mira-mission-page__message" role="status">{message}</p> : null}
          {evidenceMissions.length === 0 ? <p className="mira-mission-page__empty">{t("mira.missionDesk.evidence.empty")}</p> : evidenceMissions.map((mission) => <MissionReportCard key={mission.id} mission={mission} report={reportForMission(mission)} evidenceLabel={t("mira.missionDesk.evidence.label")} reasonLabel={t("mira.missionDesk.evidence.negativeReason")} artifactLabel={t("mira.missionDesk.evidence.artifact")} debriefLabel={t("mira.missionDesk.evidence.debrief")} pendingLabel={t("mira.missionDesk.evidence.pending")} onReview={reviewMission} />)}
        </section>
      ) : null}

      {activeTab === "results" ? (
        <section className="mira-mission-page__report-panel" role="tabpanel" aria-label={t("mira.missionDesk.tabs.results")}>
          <div className="mira-mission-page__panel-heading"><div><h2>{t("mira.missionDesk.results.title")}</h2><p>{t("mira.missionDesk.results.subtitle")}</p></div><StatusBadge tone="info">Review-only</StatusBadge></div>
          {message ? <p className="mira-mission-page__message" role="status">{message}</p> : null}
          {terminalMissions.length === 0 ? <p className="mira-mission-page__empty">{t("mira.missionDesk.results.empty")}</p> : terminalMissions.map((mission) => <MissionReportCard key={mission.id} mission={mission} report={reportForMission(mission)} evidenceLabel={t("mira.missionDesk.evidence.label")} reasonLabel={t("mira.missionDesk.evidence.negativeReason")} artifactLabel={t("mira.missionDesk.evidence.artifact")} debriefLabel={t("mira.missionDesk.evidence.debrief")} pendingLabel={t("mira.missionDesk.evidence.pending")} onReview={reviewMission} />)}
        </section>
      ) : null}

      <section className="mira-mission-page__capabilities" aria-label={t("mira.missionDesk.title")}>
        <article><span>Çalışma</span><strong>Worker görevi alır, kaynağı seçer ve sonucu geri yollar.</strong></article>
        <article><span>Kanıt</span><strong>Bulunan veri artifact, debrief ve gerekçeyle görünür.</strong></article>
        <article><span>Kontrol</span><strong>Catalog değişikliği ayrı review ve Apply kararı ister.</strong></article>
      </section>
    </PageShell>
  );
}
