export type PortalNotice = { kind: "success" | "warning"; message: string };
export type PortalFeedbackState = {
  error: string;
  status: string;
  notice: PortalNotice | null;
  backgroundMessage: string;
};
export const emptyPortalFeedback: PortalFeedbackState = { error: "", status: "", notice: null, backgroundMessage: "" };
type FeedbackAction =
  | { type: "error" | "status" | "background"; message: string }
  | { type: "notify"; message: string; kind: PortalNotice["kind"] }
  | { type: "dismiss" | "reset" };

export function portalFeedbackReducer(state: PortalFeedbackState, action: FeedbackAction): PortalFeedbackState {
  switch (action.type) {
    case "background": return { ...state, backgroundMessage: action.message };
    case "status": return { ...state, status: action.message };
    case "error": return { ...state, error: action.message, ...(action.message ? { notice: null, status: "" } : {}) };
    case "notify": return state.error ? state : { ...state, status: action.message, notice: { kind: action.kind, message: action.message } };
    case "dismiss": return { ...state, error: "", notice: null };
    case "reset": return emptyPortalFeedback;
  }
}
