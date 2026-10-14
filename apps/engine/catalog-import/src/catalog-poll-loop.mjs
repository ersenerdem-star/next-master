import { setTimeout as delay } from "node:timers/promises";

const NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

export function isTransientCatalogTransportError(error) {
  // DOMException TimeoutError has a numeric code (23), not a transport code.
  if (error?.name === "TimeoutError") return true;
  if (NETWORK_CODES.has(error?.code) || NETWORK_CODES.has(error?.cause?.code)) return true;
  const message = String(error?.message || "");
  return /^CATALOG_(?:SUPABASE_)?HTTP_(408|425|429|5\d\d)$/.test(message)
    || error?.name === "TypeError" && /fetch failed|failed to fetch|network error/i.test(message);
}

class CatalogQueueReadError extends Error {
  constructor(operation, cause) {
    super("CATALOG_QUEUE_READ_TEMPORARILY_UNAVAILABLE", { cause });
    this.operation = operation;
  }
}

// Only queue-discovery GETs use this wrapper. Domain RPCs and workflow failures
// must keep their existing receipt/lease/error handling, never a blind retry.
export async function readCatalogQueue(operation, read, { signal } = {}) {
  signal?.throwIfAborted();
  try {
    const result = await read();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (isTransientCatalogTransportError(error)) throw new CatalogQueueReadError(operation, error);
    throw error;
  }
}

export async function runCatalogPollLoop({ poll, signal, pollMs = 10_000, maxBackoffMs = 60_000, random = Math.random, wait = delay, log = () => {} }) {
  if (!Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(maxBackoffMs) || maxBackoffMs < pollMs) {
    throw new Error("CATALOG_POLL_INTERVAL_INVALID");
  }
  let failures = 0;
  while (!signal?.aborted) {
    let waitMs = pollMs;
    try {
      await poll(signal);
      if (failures) log({ status: "queue-read-recovered", failedPolls: failures });
      failures = 0;
    } catch (error) {
      if (signal?.aborted) break;
      if (!(error instanceof CatalogQueueReadError)) throw error;
      failures += 1;
      const exponential = Math.min(maxBackoffMs, pollMs * 2 ** Math.min(failures - 1, 16));
      const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
      waitMs = Math.min(maxBackoffMs, Math.max(1, Math.round(exponential * jitter)));
      log({ status: "queue-read-deferred", operation: error.operation, errorCode: error.message, failedPolls: failures, retryAfterMs: waitMs });
    }
    if (signal?.aborted) break;
    try {
      await wait(waitMs, undefined, { signal });
    } catch (error) {
      if (signal?.aborted) break;
      throw error;
    }
  }
}
