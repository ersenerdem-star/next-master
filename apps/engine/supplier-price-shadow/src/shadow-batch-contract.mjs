const STAGING_HOST = "ztzxxogozgaojgabnvpg.supabase.co";
const first = (response) => Array.isArray(response) ? response[0] : response;

export function requireShadowStagingHost(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.host !== STAGING_HOST || parsed.username || parsed.password) {
    throw new Error("SHADOW_PERSIST_STAGING_HOST_REQUIRED");
  }
}

export function requireCompleteShadowScan(claim, scan, persist) {
  const start = Number(claim.cursor_start);
  const end = Number(claim.cursor_end);
  const count = end - start + 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || count < 1
      || count > 10000 || scan.batchRows !== count || scan.cursorEnd !== end
      || scan.acceptedRows + scan.warningRows + scan.rejectedRows !== count) {
    throw new Error("SHADOW_BATCH_SCAN_INCOMPLETE");
  }
  if (!persist) return;
  if (!Array.isArray(scan.rows) || scan.rows.length !== count) throw new Error("SHADOW_BATCH_ROWS_MISSING");
  for (let index = 0; index < count; index += 1) {
    if (scan.rows[index].source_row_number !== start + index) throw new Error("SHADOW_BATCH_ROW_SEQUENCE_INVALID");
  }
}

export function requireShadowStageReceipt(response, claim, count) {
  const receipt = first(response);
  if (receipt?.status !== "staged" || Number(receipt.staged_rows) !== count
      || receipt.batch_id !== claim.batch_id || receipt.release_id_result !== claim.release_id) {
    throw new Error(`SHADOW_STAGE_INCOMPLETE:${receipt?.status || "missing"}`);
  }
}

export function requireShadowHeartbeatReceipt(response, claim, scan) {
  const receipt = first(response);
  if (receipt?.status !== "heartbeat" || receipt.batch_id !== claim.batch_id
      || Number(receipt.current_cursor) !== scan.cursorEnd || Number(receipt.processed_rows) !== scan.batchRows) {
    throw new Error(`SHADOW_HEARTBEAT_INCOMPLETE:${receipt?.status || "missing"}`);
  }
}

export function requireShadowDrainProgress(result, previousCursor = 0) {
  const claim = result?.claim;
  if (claim?.status === "complete") return { complete: true, cursor: previousCursor };
  const receipt = first(result?.finalized);
  if (claim?.status !== "claimed" || receipt?.status !== "finalized") {
    throw new Error(`SHADOW_DRAIN_NOT_READY:${claim?.status || "missing"}`);
  }
  const cursor = Number(receipt.current_cursor);
  if (!Number.isSafeInteger(cursor) || cursor <= previousCursor || cursor !== Number(claim.cursor_end)) {
    throw new Error("SHADOW_DRAIN_NO_PROGRESS");
  }
  return { complete: receipt.release_status === "staged", cursor };
}
