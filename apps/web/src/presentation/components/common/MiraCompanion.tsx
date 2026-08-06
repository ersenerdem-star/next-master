import { useEffect, useState } from "react";

type MiraState = "away" | "road" | "home";

const STATES: MiraState[] = ["away", "road", "home"];

/** Visual-only MIRA companion. The demo state loop is not connected to Catalog data. */
export function MiraCompanion() {
  const [stateIndex, setStateIndex] = useState(2);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStateIndex((current) => (current + 1) % STATES.length);
    }, 5200);

    return () => window.clearInterval(timer);
  }, []);

  const activeState = STATES[stateIndex];

  return (
    <section className={`mira-companion mira-companion--${activeState}`} aria-label="MIRA visual companion">
      <div className="mira-companion__copy">
        <span className="mira-companion__eyebrow">MIRA</span>
        <h2>Operations companion</h2>
        <p>Present on the dashboard while you work.</p>
      </div>
      <div className="mira-companion__figure" aria-hidden="true">
        <img className="mira-companion__frame mira-companion__frame--away" src="/mira/mira-away.png" alt="" />
        <img className="mira-companion__frame mira-companion__frame--road" src="/mira/mira-road.png" alt="" />
        <img className="mira-companion__frame mira-companion__frame--home" src="/mira/mira-home.png" alt="" />
      </div>
      <div className="mira-companion__state" aria-live="polite">
        <span className="mira-companion__state-dot" />
        {activeState === "away" ? "Away" : activeState === "road" ? "On the road" : "At home"}
      </div>
    </section>
  );
}
