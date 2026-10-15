import {InterfaceText,useInterfaceText} from "../../../i18n/InterfaceText";
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
  const ui=useInterfaceText();
  const [isOpen, setIsOpen] = useState(false);

  function openMissionDesk() {
    setIsOpen(false);
    onOpenMissionDesk?.();
  }

  return (
    <aside
      className={`mira-companion${embedded ? " mira-companion--embedded" : ""} mira-companion--home`}
      data-mira-entry={embedded ? "build-context" : "legacy-floating"}
      aria-label={ui("MIRA online assistant")}
    >
      <button
        type="button"
        className="mira-companion__launcher"
        aria-label={ui("Open MIRA online mission control")}
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
          <span><InterfaceText text={"Online"}/></span>
        </span>
      </button>

      {isOpen ? (
        <section className="mira-companion__panel" aria-label={ui("MIRA online mission control")}>
          <header className="mira-companion__panel-header">
            <div>
              <strong><InterfaceText text={"MIRA online"}/></strong>
              <span><InterfaceText text={"Authenticated mission control"}/></span>
            </div>
            <button type="button" className="mira-companion__close" onClick={() => setIsOpen(false)} aria-label={ui("Close MIRA panel")}>
              ×
            </button>
          </header>
          <div className="mira-companion__guard-note">
            <InterfaceText text={"Create and track missions in the online queue. Catalog changes still require a separate human review and Apply step."}/></div>
          <button type="button" className="mira-companion__primary-action" onClick={openMissionDesk}>
            <InterfaceText text={"Open MIRA mission control"}/></button>
        </section>
      ) : null}
    </aside>
  );
}
