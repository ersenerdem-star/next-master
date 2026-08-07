import { PageHeader, PageShell, StatusBadge } from "../components/common/VisualPrimitives";
import { useI18n } from "../../i18n/I18nProvider";

const MIRA_MISSION_DESK_URL = "http://127.0.0.1:4310";

export function MiraMissionDeskPage() {
  const { t } = useI18n();

  return (
    <PageShell className="mira-mission-page">
      <PageHeader
        eyebrow={t("mira.missionDesk.eyebrow")}
        title={t("mira.missionDesk.title")}
        subtitle={t("mira.missionDesk.subtitle")}
        status={<StatusBadge tone="success">{t("mira.missionDesk.home")}</StatusBadge>}
        actions={
          <a className="button button--primary" href={MIRA_MISSION_DESK_URL} target="_blank" rel="noreferrer">
            {t("mira.missionDesk.open")}
          </a>
        }
      />

      <section className="mira-mission-page__hero" aria-labelledby="mira-mission-copy">
        <div className="mira-mission-page__visual">
          <img src="/mira/mira-home.png" alt="MIRA" />
          <span className="mira-mission-page__glow" aria-hidden="true" />
        </div>
        <div className="mira-mission-page__copy">
          <h2 id="mira-mission-copy">{t("mira.missionDesk.home")}</h2>
          <p>{t("mira.missionDesk.copy")}</p>
          <div className="mira-mission-page__address">
            <span>{t("mira.missionDesk.address")}</span>
            <code>{MIRA_MISSION_DESK_URL}</code>
          </div>
          <div className="mira-mission-page__boundary">
            <strong>{t("mira.missionDesk.boundary")}</strong>
          </div>
        </div>
      </section>

      <section className="mira-mission-page__capabilities" aria-label={t("mira.missionDesk.title")}>
        <article>
          <span className="mira-mission-page__capability-icon" aria-hidden="true">◎</span>
          <h3>{t("mira.missionDesk.worker")}</h3>
          <p>{t("mira.missionDesk.workerCopy")}</p>
        </article>
        <article>
          <span className="mira-mission-page__capability-icon" aria-hidden="true">≋</span>
          <h3>{t("mira.missionDesk.queue")}</h3>
          <p>{t("mira.missionDesk.queueCopy")}</p>
        </article>
        <article>
          <span className="mira-mission-page__capability-icon" aria-hidden="true">✓</span>
          <h3>{t("mira.missionDesk.debrief")}</h3>
          <p>{t("mira.missionDesk.debriefCopy")}</p>
        </article>
      </section>
    </PageShell>
  );
}
