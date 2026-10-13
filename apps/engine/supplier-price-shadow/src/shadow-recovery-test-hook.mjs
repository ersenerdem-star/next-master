import { RECOVERY_RELEASE_ID } from "./recovery-test-fixture.mjs";
import { requireShadowStagingHost } from "./shadow-batch-contract.mjs";

export function requireRecoveryTestHook({ enabled, releaseId, supabaseUrl, canSend }) {
  if (!enabled) return;
  requireShadowStagingHost(supabaseUrl);
  if (releaseId !== RECOVERY_RELEASE_ID || !canSend) {
    throw new Error("RECOVERY_TEST_HOOK_REQUIRES_ISOLATED_FIXTURE_AND_IPC");
  }
}

// Called outside durable steps, after the successful stage step is checkpointed.
// Only this dedicated synthetic fixture may pause, never VAG or production.
export async function pauseRecoveryTestAfterStage(releaseId, batch, stagedRows) {
  const enabled = process.env.SUPPLIER_PRICE_RECOVERY_TEST_PAUSE_AFTER_STAGE === "1";
  requireRecoveryTestHook({ enabled, releaseId, supabaseUrl: process.env.SUPABASE_URL,
    canSend: typeof process.send === "function" });
  if (!enabled) return;
  if (Number(batch.cursor_start) !== 1 || Number(batch.cursor_end) !== 2 || stagedRows !== 2) {
    throw new Error("RECOVERY_TEST_EXPECTED_FIRST_TWO_ROWS");
  }
  await new Promise((resolve, reject) => process.send({
    type: "recovery-test-stage-checkpoint", releaseId, batchId: batch.batch_id,
    stagedRows, cursorStart: Number(batch.cursor_start), cursorEnd: Number(batch.cursor_end),
  }, error => error ? reject(error) : resolve()));
  await new Promise(() => {}); // Harness SIGKILLs only its own spawned child.
}
