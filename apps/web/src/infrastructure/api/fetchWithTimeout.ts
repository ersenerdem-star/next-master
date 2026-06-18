export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 30000,
  label = "Request",
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught || "");
    if (controller.signal.aborted || message.toLowerCase().includes("abort")) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw caught;
  } finally {
    window.clearTimeout(timeout);
  }
}
