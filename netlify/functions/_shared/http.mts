import { sanitizeUserFacingMessage } from "./user-message.mts";

export const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });

export async function readJson<T>(response: Response) {
  return (await response.json().catch((error) => {
    if (error?.name === "AbortError") throw error;
    return {};
  })) as T;
}

export class HttpTimeoutError extends Error {
  constructor() {
    super("Upstream request timed out");
    this.name = "HttpTimeoutError";
  }
}

// Preserve machine-readable failures for server-side recovery decisions.
// Keep the public message sanitized and raw database text non-enumerable.
export class HttpRequestError extends Error {
  readonly status: number;
  readonly code: string;
  declare readonly rawMessage: string;

  constructor(status: number, data: { message?: unknown; error?: unknown; msg?: unknown; code?: unknown }) {
    const rawMessage = String(data?.msg || data?.message || data?.error || `Request failed: ${status}`);
    super(sanitizeUserFacingMessage(rawMessage));
    this.name = "HttpRequestError";
    this.status = status;
    this.code = String(data?.code || "");
    Object.defineProperty(this, "rawMessage", { value: rawMessage, enumerable: false });
  }
}

async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number }) {
  const { timeoutMs, signal, ...requestInit } = init;
  const controller = timeoutMs && !signal ? new AbortController() : null;
  const timeoutHandle =
    timeoutMs && controller
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;
  try {
    const response = await fetch(url, {
      ...requestInit,
      signal: signal || controller?.signal,
    });
    // The deadline covers the body too, not just receipt of HTTP headers.
    const data = await readJson<T & { message?: string; error?: string; msg?: string; code?: string }>(response);
    if (controller?.signal.aborted || signal?.aborted) throw new HttpTimeoutError();
    return { response, data };
  } catch (error) {
    if ((error instanceof DOMException && error.name === "AbortError") || String(error || "").toLowerCase().includes("aborted")) {
      throw new HttpTimeoutError();
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function getJson<T>(url: string, init: RequestInit & { timeoutMs?: number }) {
  const { response, data } = await fetchJson<T>(url, init);
  if (!response.ok) {
    throw new HttpRequestError(response.status, data);
  }
  return data as T;
}

export async function sendJson<T>(url: string, init: RequestInit & { timeoutMs?: number }) {
  const { response, data } = await fetchJson<T>(url, init);
  if (!response.ok) {
    throw new HttpRequestError(response.status, data);
  }
  return data as T;
}

export function buildRestUrl(supabaseUrl: string, table: string, params: Record<string, string>) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function serviceRoleHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}
