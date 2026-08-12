import { useState } from "react";

type MiraCompanionProps = {
  embedded?: boolean;
  onOpenMissionDesk?: () => void;
};

/**
 * The companion is only a compact entry point. Missions are created and
 * tracked in the authenticated online Mission Desk, never in browser storage.
 */
export function MiraCompanion({ embedded = false, onOpenMissionDesk }: MiraCompanionProps) {
  const [isOpen, setIsOpen] = useState(false);

  function openMissionDesk() {
    setIsOpen(false);
    onOpenMissionDesk?.();
  }

  return (
    <aside
      className={`mira-companion${embedded ? " mira-companion--embedded" : ""} mira-companion--home`}
      aria-label="MIRA online assistant"
    >
      <button
        type="button"
        className="mira-companion__launcher"
        aria-label="Open MIRA online mission control"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="mira-companion__halo" aria-hidden="true" />
        <span className="mira-companion__figure" aria-hidden="true">
          <img className="mira-companion__frame mira-companion__frame--home" src="/mira/mira-home.png" alt="" />
        </span>
        <span className="mira-companion__badge" aria-live="polite">
          <span className="mira-companion__state-dot" />
          <strong>MIRA</strong>
          <span>Online</span>
        </span>
      </button>

      {isOpen ? (
        <section className="mira-companion__panel" aria-label="MIRA online mission control">
          <header className="mira-companion__panel-header">
            <div>
              <strong>MIRA online</strong>
              <span>Authenticated mission control</span>
            </div>
            <button type="button" className="mira-companion__close" onClick={() => setIsOpen(false)} aria-label="Close MIRA panel">
              ×
            </button>
          </header>
          <div className="mira-companion__guard-note">
            Create and track missions in the online queue. Catalog changes still require a separate human review and Apply step.
          </div>
          <button type="button" className="mira-companion__primary-action" onClick={openMissionDesk}>
            Open MIRA mission control
          </button>
        </section>
      ) : null}
    </aside>
  );
}
