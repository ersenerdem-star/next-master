export function shadowWorkerQueueName({ expiryRole = "", releaseId }) {
  if (!expiryRole) return "supplier-price-shadow";
  if (!["a", "b"].includes(expiryRole) || !/^[0-9a-f-]{36}$/.test(releaseId || "")) {
    throw new Error("INVALID_EXPIRY_QUEUE_SCOPE");
  }
  // Executor IDs govern recovery, not queued execution ownership. Only the
  // expiry test uses actor-specific queues; normal workers keep the shared queue.
  return `supplier-price-expiry:${releaseId}:${expiryRole}`;
}
