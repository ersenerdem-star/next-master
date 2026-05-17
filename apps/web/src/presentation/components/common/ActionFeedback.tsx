import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ActionFeedbackKind = "idle" | "progress" | "success" | "error";

type ActionFeedbackContextValue = {
  begin: (message: string) => void;
  succeed: (message: string) => void;
  fail: (message: string) => void;
  clear: () => void;
};

const ActionFeedbackContext = createContext<ActionFeedbackContextValue | null>(null);

export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
  const [kind, setKind] = useState<ActionFeedbackKind>("idle");
  const [message, setMessage] = useState("");
  const timeoutRef = useRef<number | null>(null);

  function clearPendingTimer() {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  useEffect(() => {
    return () => clearPendingTimer();
  }, []);

  const value = useMemo<ActionFeedbackContextValue>(
    () => ({
      begin(nextMessage) {
        clearPendingTimer();
        setKind("progress");
        setMessage(nextMessage);
      },
      succeed(nextMessage) {
        clearPendingTimer();
        setKind("success");
        setMessage(nextMessage);
        timeoutRef.current = window.setTimeout(() => {
          setKind("idle");
          setMessage("");
          timeoutRef.current = null;
        }, 1800);
      },
      fail(nextMessage) {
        clearPendingTimer();
        setKind("error");
        setMessage(nextMessage);
        timeoutRef.current = window.setTimeout(() => {
          setKind("idle");
          setMessage("");
          timeoutRef.current = null;
        }, 2600);
      },
      clear() {
        clearPendingTimer();
        setKind("idle");
        setMessage("");
      },
    }),
    [],
  );

  return (
    <ActionFeedbackContext.Provider value={value}>
      {children}
      {kind !== "idle" ? (
        <div className={`action-feedback action-feedback--${kind}`}>
          <div className="action-feedback__backdrop" />
          <div className="action-feedback__card" role="status" aria-live="polite">
            {kind === "progress" ? <span className="action-feedback__spinner" aria-hidden="true" /> : null}
            <strong>{kind === "progress" ? "Working..." : kind === "success" ? "Done" : "Action failed"}</strong>
            <span>{message}</span>
          </div>
        </div>
      ) : null}
    </ActionFeedbackContext.Provider>
  );
}

export function useActionFeedback() {
  const context = useContext(ActionFeedbackContext);
  if (!context) {
    throw new Error("useActionFeedback must be used within ActionFeedbackProvider");
  }
  return context;
}
