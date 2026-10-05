import { createHash } from "node:crypto";

// New synthetic fixture. Never reuse the successful restart or VAG fixtures.
export const EXPIRY_RELEASE_ID = "2698b1dc-1a68-49b8-a723-978182a48173";
export const EXPIRY_SOURCE_DATE = "2026-10-01";
export const EXPIRY_SOURCE_PATH = "10000000-0000-0000-0000-000000000001/supplier-price/expiry-" + EXPIRY_RELEASE_ID + ".csv";
export const EXPIRY_SOURCE_CSV = "Product_Code,Brand,Buy_Price,Currency,Price_Date,Description\n" +
  Array.from({ length: 6 }, (_, index) => `EXPIRY-${EXPIRY_RELEASE_ID}-${index + 1},SHADOW-EXPIRY,${21 + index},EUR,2026-10-01,Expiry test row ${index + 1}\n`).join("");
export const EXPIRY_SOURCE_SHA256 = createHash("sha256").update(EXPIRY_SOURCE_CSV).digest("hex");

export function isolatedExpiryDatabaseUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
      || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      || (parsed.port && parsed.port !== "5432") || parsed.search) {
    throw new Error("EXPIRY_REQUIRES_LOCAL_ISOLATED_DBOS_DATABASE");
  }
  parsed.pathname = "/nm_expiry_" + EXPIRY_RELEASE_ID.replaceAll("-", "");
  return parsed.toString();
}

export function requireExpiryCheckpoint(message, role, originalBatchId) {
  if (message?.type !== "expiry-test-stage-checkpoint" || message.releaseId !== EXPIRY_RELEASE_ID
      || message.role !== role || !message.batchId || message.stagedRows !== 2
      || message.cursorStart !== 1 || message.cursorEnd !== 2
      || message.attempt !== (role === "a" ? 1 : 2)
      || !Number.isFinite(Date.parse(message.leaseExpiresAt))
      || (originalBatchId && message.batchId !== originalBatchId)) {
    throw new Error("EXPIRY_CHECKPOINT_INVALID");
  }
}

export function requireExpiryCompletion(results, checkpoint) {
  if (!Array.isArray(results) || results.length !== 3) throw new Error("EXPIRY_EXPECTED_THREE_BATCHES");
  for (let index = 0; index < 3; index += 1) {
    const result = results[index];
    const claim = result.claim;
    const finalized = Array.isArray(result.finalized) ? result.finalized[0] : result.finalized;
    if (claim?.release_id !== EXPIRY_RELEASE_ID || claim.status !== "claimed"
        || Number(claim.cursor_start) !== index * 2 + 1 || Number(claim.cursor_end) !== index * 2 + 2
        || Number(claim.attempt) !== (index === 0 ? 2 : 1)
        || finalized?.status !== "finalized" || Number(finalized.processed_rows) !== index * 2 + 2
        || Number(finalized.current_cursor) !== index * 2 + 2
        || (index === 2 && finalized.release_status !== "staged") || result.published !== false) {
      throw new Error("EXPIRY_BATCH_ACCOUNTING_INVALID");
    }
  }
  if (results[0].claim.batch_id !== checkpoint.batchId) throw new Error("EXPIRY_BATCH_ID_CHANGED");
}
