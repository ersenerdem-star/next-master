import { EXPIRY_RELEASE_ID } from "./expiry-test-fixture.mjs";
import { requireShadowStagingHost } from "./shadow-batch-contract.mjs";

export function requireExpiryTestHook({ role, releaseId, supabaseUrl, canSend }) {
  if (!role) return;
  requireShadowStagingHost(supabaseUrl);
  if (!["a", "b"].includes(role) || releaseId !== EXPIRY_RELEASE_ID || !canSend) {
    throw new Error("EXPIRY_TEST_REQUIRES_ISOLATED_FIXTURE_ROLE_AND_IPC");
  }
}

// Short lease is permitted ONLY after the exact fixture/staging/IPC guard.
export function expiryTestLeaseSeconds() {
  return process.env.SUPPLIER_PRICE_EXPIRY_TEST_ROLE === "a" ? 30 : 120;
}

export function requireStaleExpiryProbe(receipts) {
  for (const operation of ["stage", "heartbeat", "finalize"]) {
    const receipt = Array.isArray(receipts?.[operation]) ? receipts[operation][0] : receipts?.[operation];
    if (receipt?.status !== "stale") throw new Error("EXPIRY_OLD_OWNER_NOT_FENCED:" + operation);
  }
}

// Outside DBOS steps; no effect on normal workflows. First two rows only.
// Both real workers stay alive: A stalls through natural expiry, B holds the
// reclaimed lease while A attempts all three stale writes and then resumes.
export async function pauseExpiryTestAfterStage(releaseId, batch, scan, probe) {
  const role = process.env.SUPPLIER_PRICE_EXPIRY_TEST_ROLE || "";
  requireExpiryTestHook({ role, releaseId, supabaseUrl: process.env.SUPABASE_URL,
    canSend: typeof process.send === "function" });
  if (!role || process.env.SUPPLIER_PRICE_EXPIRY_TEST_PAUSE === "0" || Number(batch.cursor_start) !== 1) return;
  if (Number(batch.cursor_end) !== 2 || scan.batchRows !== 2) throw new Error("EXPIRY_FIRST_BATCH_INVALID");
  await new Promise((resolve, reject) => {
    let probing = false;
    const cleanup = () => { process.off("message", onMessage); process.off("disconnect", onDisconnect); };
    const fail = error => { cleanup(); reject(error); };
    const onDisconnect = () => fail(new Error("EXPIRY_CONTROLLER_DISCONNECTED"));
    const onMessage = async message => {
      if (message?.releaseId !== EXPIRY_RELEASE_ID || message?.role !== role) return;
      if (message.type === "expiry-resume") {
        if (probing) return;
        cleanup(); resolve(); return;
      }
      if (message.type !== "expiry-probe-stale" || role !== "a" || probing) return;
      probing = true;
      try {
        for (const operation of ["stage", "heartbeat", "finalize"]) {
          const response = await probe(operation);
          const receipt = Array.isArray(response) ? response[0] : response;
          if (receipt?.status !== "stale") throw new Error("EXPIRY_OLD_OWNER_NOT_FENCED:" + operation);
        }
        probing = false;
        process.send({ type: "expiry-stale-probe", releaseId, role, batchId: batch.batch_id,
          stage: "stale", heartbeat: "stale", finalize: "stale" }, error => { if (error) fail(error); });
      } catch (error) { fail(error); }
    };
    process.on("message", onMessage); process.once("disconnect", onDisconnect);
    process.send({ type: "expiry-test-stage-checkpoint", releaseId, role, batchId: batch.batch_id,
      stagedRows: scan.batchRows, cursorStart: Number(batch.cursor_start), cursorEnd: Number(batch.cursor_end),
      attempt: Number(batch.attempt), leaseExpiresAt: batch.lease_expires_at }, error => { if (error) fail(error); });
  });
}
