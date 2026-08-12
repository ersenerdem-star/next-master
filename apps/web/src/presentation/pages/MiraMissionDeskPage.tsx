import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PageHeader, PageShell, StatusBadge } from "../components/common/VisualPrimitives";
import { useI18n } from "../../i18n/I18nProvider";
import { listMiraMissions, queueMiraMission, type MiraMission } from "../../infrastructure/api/miraMissionsApi";

type MiraDeskTab = "queue" | "evidence" | "results";

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
  const nested = [result, debrief, handoff, authority].filter((value): value is Record<string, unknown> => Boolean(value));
  const read = (...keys: string[]) => readRecordValue(nested, ...keys);
  const pagesObserved = readNumber(read("pagesObserved", "pages_observed", "pageCount", "page_count"));
  const candidates = readNumber(read("eanCandidates", "ean_candidates", "candidateCount", "candidate_count", "observationCount", "observation_count"));
  const resultStatus = firstText(read("status", "outcome", "resultStatus", "result_status"), mission.status);
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
      ? "Doğrulanmış EAN adayı bulunmadı; kaynak çıktısı kanıt için yetersiz kaldı."
      : null
  );

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

function MissionReportCard({ mission, report, evidenceLabel, reasonLabel, artifactLabel, debriefLabel, pendingLabel }: {
  mission: MiraMission;
  report: MissionReport;
  evidenceLabel: string;
  reasonLabel: string;
  artifactLabel: string;
  debriefLabel: string;
  pendingLabel: string;
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
      {mission.status === "failed" || report.negativeReason || report.candidates === 0 ? (
        <div className="mira-mission-page__negative-result" role="status">
          <strong>{reasonLabel}</strong>
          <span>{report.negativeReason || "Görev sonuç üretmedi; worker bir neden döndürmedi."}</span>
        </div>
      ) : null}
      <p className="mira-mission-page__report-summary"><strong>Sonuç:</strong> {summaryText}</p>
      {evidenceText ? <div className="mira-mission-page__evidence-value"><strong>{evidenceLabel}</strong><code>{evidenceText}</code></div> : <p className="mira-mission-page__artifact-empty">{mission.status === "queued" || mission.status === "processing" ? pendingLabel : `${evidenceLabel}: henüz kanıt yok.`}</p>}
      {safetyItems ? <div className="mira-mission-page__safety-result"><strong>MIRA ne yapmadı?</strong><span>{safetyItems}</span></div> : null}
      {listText(report.knowledgeGaps) ? <div className="mira-mission-page__report-detail"><strong>Açık kalan konu</strong><span>{listText(report.knowledgeGaps)}</span></div> : null}
      {listText(report.learning) ? <div className="mira-mission-page__report-detail"><strong>Öğrenilen</strong><span>{listText(report.learning)}</span></div> : null}
      {listText(report.authorityFindings) ? <div className="mira-mission-page__report-detail"><strong>Yetki / kaynak bulgusu</strong><span>{listText(report.authorityFindings)}</span></div> : null}
      <div className="mira-mission-page__artifact-grid">
        <ArtifactReference label={artifactLabel} path={report.artifactPath} url={report.artifactUrl} />
        <ArtifactReference label={debriefLabel} path={report.debriefPath} url={report.debriefUrl} />
      </div>
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
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  async function refresh() {
    setLoading(true);
    try {
      setMissions(await listMiraMissions());
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA online status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await queueMiraMission({ objective, missionArea, maxPages, delayMs });
      if (result.mission) setMissions((items) => [result.mission, ...items]);
      setObjective("");
      setActiveTab("queue");
      setMessage("MIRA görev online kuyruğa alındı. Worker bağlandığında çalışmaya başlayacak.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MIRA görevi kuyruğa alınamadı.");
    } finally {
      setSubmitting(false);
    }
  }

  const reportMissions = useMemo(() => missions.filter((mission) => mission.status !== "queued" || mission.result || mission.error_message), [missions]);
  const tabs: Array<{ id: MiraDeskTab; label: string; count: number }> = [
    { id: "queue", label: t("mira.missionDesk.tabs.queue"), count: missions.length },
    { id: "evidence", label: t("mira.missionDesk.tabs.evidence"), count: reportMissions.length },
    { id: "results", label: t("mira.missionDesk.tabs.results"), count: missions.filter((mission) => ["completed", "partial", "blocked", "failed", "cancelled"].includes(mission.status)).length },
  ];

  return (
    <PageShell className="mira-mission-page">
      <PageHeader
        eyebrow={t("mira.missionDesk.eyebrow")}
        title={t("mira.missionDesk.title")}
        subtitle={t("mira.missionDesk.subtitle")}
        status={<StatusBadge tone="success">Online · Review-only</StatusBadge>}
        actions={<button className="button button--secondary" type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>}
      />

      <section className="mira-mission-page__hero" aria-labelledby="mira-mission-copy">
        <div className="mira-mission-page__visual"><img src="/mira/mira-home.png" alt="MIRA" /><span className="mira-mission-page__glow" aria-hidden="true" /></div>
        <div className="mira-mission-page__copy">
          <h2 id="mira-mission-copy">MIRA online görev masası</h2>
          <p>Görevi buradan ver. MIRA üretimde oturumla korunan kuyruğa kaydeder; sonuçlar review-only olarak döner.</p>
          <div className="mira-mission-page__address"><span>Durum</span><code>/api/mira-missions · authenticated</code></div>
          <div className="mira-mission-page__boundary"><strong>Catalog’a otomatik yazma, Apply ve yetki genişletme kapalıdır.</strong></div>
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
            <label>Görev<input value={objective} onChange={(event) => setObjective(event.target.value)} minLength={8} maxLength={500} placeholder="Örn. Bosch resmi kaynaklarında EAN adaylarını gözlemle" required /></label>
            <label>Görev alanı<select value={missionArea} onChange={(event) => setMissionArea(event.target.value)}><option>Public catalog signal</option><option>Supplier market watch</option><option>Customer demand review</option></select></label>
            <div className="mira-mission-page__form-row"><label>Sayfa bütçesi<input type="number" min="1" max="50" value={maxPages} onChange={(event) => setMaxPages(Number(event.target.value))} /></label><label>İstek aralığı (ms)<input type="number" min="1000" max="10000" step="100" value={delayMs} onChange={(event) => setDelayMs(Number(event.target.value))} /></label></div>
            <button className="button button--primary" type="submit" disabled={submitting}>{submitting ? "Kuyruğa alınıyor…" : "MIRA’ya görev ver"}</button>
            {message ? <p className="mira-mission-page__message" role="status">{message}</p> : null}
          </form>
          <section className="mira-mission-page__online-queue" aria-label="MIRA mission queue"><div className="mira-mission-page__queue-header"><h2>Online görev kuyruğu</h2><span>{missions.length} kayıt</span></div>{missions.length === 0 && !loading ? <p>Henüz online görev yok.</p> : missions.map((mission) => <article key={mission.id} className="mira-mission-page__queue-item"><div><strong>{mission.objective}</strong><small>{mission.mission_area} · {mission.max_pages} sayfa · {mission.delay_ms} ms</small></div><StatusBadge tone={statusTone(mission.status)}>{mission.status}</StatusBadge></article>)}</section>
        </section>
      ) : null}

      {activeTab === "evidence" ? (
        <section className="mira-mission-page__report-panel" role="tabpanel" aria-label={t("mira.missionDesk.tabs.evidence")}>
          <div className="mira-mission-page__panel-heading"><div><h2>{t("mira.missionDesk.evidence.title")}</h2><p>{t("mira.missionDesk.evidence.subtitle")}</p></div><StatusBadge tone="info">Review-only</StatusBadge></div>
          {missions.length === 0 ? <p className="mira-mission-page__empty">{t("mira.missionDesk.evidence.empty")}</p> : missions.map((mission) => <MissionReportCard key={mission.id} mission={mission} report={reportForMission(mission)} evidenceLabel={t("mira.missionDesk.evidence.label")} reasonLabel={t("mira.missionDesk.evidence.negativeReason")} artifactLabel={t("mira.missionDesk.evidence.artifact")} debriefLabel={t("mira.missionDesk.evidence.debrief")} pendingLabel={t("mira.missionDesk.evidence.pending")} />)}
        </section>
      ) : null}

      {activeTab === "results" ? (
        <section className="mira-mission-page__report-panel" role="tabpanel" aria-label={t("mira.missionDesk.tabs.results")}>
          <div className="mira-mission-page__panel-heading"><div><h2>{t("mira.missionDesk.results.title")}</h2><p>{t("mira.missionDesk.results.subtitle")}</p></div><StatusBadge tone="info">Review-only</StatusBadge></div>
          {reportMissions.length === 0 ? <p className="mira-mission-page__empty">{t("mira.missionDesk.results.empty")}</p> : reportMissions.map((mission) => <MissionReportCard key={mission.id} mission={mission} report={reportForMission(mission)} evidenceLabel={t("mira.missionDesk.evidence.label")} reasonLabel={t("mira.missionDesk.evidence.negativeReason")} artifactLabel={t("mira.missionDesk.evidence.artifact")} debriefLabel={t("mira.missionDesk.evidence.debrief")} pendingLabel={t("mira.missionDesk.evidence.pending")} />)}
        </section>
      ) : null}

      <section className="mira-mission-page__capabilities" aria-label={t("mira.missionDesk.title")}>
        <article><span className="mira-mission-page__capability-icon" aria-hidden="true">◎</span><h3>{t("mira.missionDesk.worker")}</h3><p>Online görev kuyruğu üretimde durur; worker bağlantısı ayrıca açılır.</p></article>
        <article><span className="mira-mission-page__capability-icon" aria-hidden="true">≋</span><h3>{t("mira.missionDesk.queue")}</h3><p>Görevler oturum ve organizasyon sınırıyla saklanır.</p></article>
        <article><span className="mira-mission-page__capability-icon" aria-hidden="true">✓</span><h3>{t("mira.missionDesk.debrief")}</h3><p>Sonuçlar review-only kalır; insan kararı olmadan Catalog değişmez.</p></article>
      </section>
    </PageShell>
  );
}
