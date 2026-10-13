type ExportProgressEvent = {
  stage?: string;
  processedRows?: number | null;
  totalRows?: number | null;
};

// The worker renews its lease independently. Limit advisory progress writes,
// while always showing the first update, a phase change, and a phase's end.
export function createThrottledExportProgress({
  expectedRows,
  report,
  now = () => performance.now(),
  intervalMs = 20_000,
}: {
  expectedRows: number;
  report: (event: ExportProgressEvent & { stage: string; totalRows: number }) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
}) {
  let lastStage: string | null = null;
  let lastReportedAt = Number.NEGATIVE_INFINITY;
  let lastReportedRows: number | null = null;

  return async (event: ExportProgressEvent): Promise<boolean> => {
    if (event.processedRows == null) return false;
    const stage = event.stage || "processing";
    const totalRows = event.totalRows ?? expectedRows;
    const finished = event.processedRows >= totalRows;
    const sameUpdate = stage === lastStage && event.processedRows === lastReportedRows;
    if (sameUpdate || stage === lastStage && !finished && now() - lastReportedAt < intervalMs) return false;

    // A failed advisory write must remain retryable at the next page.
    await report({ ...event, stage, totalRows });
    lastStage = stage;
    lastReportedRows = event.processedRows;
    lastReportedAt = now();
    return true;
  };
}
