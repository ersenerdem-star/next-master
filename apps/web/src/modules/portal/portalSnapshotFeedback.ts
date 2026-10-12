export const PORTAL_PARTIAL_DATA_MESSAGE = "Some account data could not be loaded. Displayed information may be incomplete; select Refresh to retry.";

export function portalSnapshotFeedback(snapshot: { dataStatus?: "degraded" }, successMessage: string) {
  return snapshot.dataStatus === "degraded"
    ? { message: PORTAL_PARTIAL_DATA_MESSAGE, kind: "warning" as const }
    : { message: successMessage, kind: "success" as const };
}
