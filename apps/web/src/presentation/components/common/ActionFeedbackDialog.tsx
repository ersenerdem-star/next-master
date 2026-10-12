import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export type ActionFeedbackKind = "progress" | "success" | "error" | "warning";

export function getActionFeedbackCopy(kind: ActionFeedbackKind, message: string) {
  if (kind === "progress") return { eyebrow: "Processing", title: "Working on it", helper: "" };
  if (kind === "success") return { eyebrow: "Completed", title: "Done", helper: "" };
  if (kind === "warning") return { eyebrow: "Please review", title: "Attention required", helper: "Review the details before continuing." };
  const normalized = message.toLowerCase();
  if (normalized.includes("price list") && normalized.includes("not available")) {
    return { eyebrow: "Attention required", title: "Price list not available", helper: "Select another brand or ask your seller about this price list." };
  }
  if (/timed out|too long|504|failed to fetch/.test(normalized)) {
    return { eyebrow: "Attention required", title: "Request needs attention", helper: "We could not confirm the result. Check the current order or download status before retrying to avoid repeating the operation." };
  }
  if (/session expired|sign in|credentials/.test(normalized)) {
    return { eyebrow: "Attention required", title: "Session needs attention", helper: "Check your sign-in details and try again." };
  }
  return { eyebrow: "Attention required", title: "Action needs attention", helper: "Review the message and correct the information before trying again." };
}

/** One viewport-level presentation for admin and portal; never inside a scaled page. */
export function ActionFeedbackDialog({ kind, message, title, onClose }: {
  kind: ActionFeedbackKind;
  message: string;
  title?: string;
  onClose?: () => void;
}) {
  const id = useId();
  const cardRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissible = Boolean(onClose) && kind !== "progress";
  const copy = getActionFeedbackCopy(kind, message);

  useEffect(() => {
    const root = rootRef.current;
    const card = cardRef.current;
    if (!root || !card) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const siblings = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== root);
    const inertStates = siblings.map(node => [node, node.inert] as const);
    inertStates.forEach(([node]) => { node.inert = true; });
    document.body.style.overflow = "hidden";
    const focusTarget = card.querySelector<HTMLButtonElement>("button") || card;
    focusTarget.focus({ preventScroll: true });
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current?.();
      }
      if (event.key === "Tab") {
        // Feedback has one optional dismiss control. Keep focus out of the page behind it.
        event.preventDefault();
        focusTarget.focus({ preventScroll: true });
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      inertStates.forEach(([node, inert]) => { node.inert = inert; });
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [dismissible]);

  const overlay = (
    <div ref={rootRef} className={`action-feedback action-feedback--${kind}`}>
      <div className="action-feedback__backdrop" aria-hidden="true" />
      <section ref={cardRef} className="action-feedback__card" tabIndex={-1}
        role={kind === "error" || kind === "warning" ? "alertdialog" : "dialog"}
        aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}>
        <div className="action-feedback__icon" aria-hidden="true">
          {kind === "progress" ? <span className="action-feedback__spinner" /> : kind === "success" ? "✓" : "!"}
        </div>
        <div className="action-feedback__body">
          <span className="action-feedback__eyebrow">{copy.eyebrow}</span>
          <strong id={`${id}-title`}>{title || copy.title}</strong>
          <span id={`${id}-message`} role={kind === "progress" ? "status" : undefined} aria-live={kind === "progress" ? "polite" : undefined}>{message}</span>
          {copy.helper ? <small>{copy.helper}</small> : null}
          {dismissible ? <div className="action-feedback__actions">
            <button type="button" className="action-feedback__button" onClick={onClose}>Close</button>
          </div> : null}
        </div>
      </section>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(overlay, document.body) : overlay;
}
