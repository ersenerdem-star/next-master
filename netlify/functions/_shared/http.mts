import { sanitizeUserFacingMessage } from "./user-message.mts";

export const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });

export async function readJson<T>(response: Response) {
  return (await response.json().catch(() => ({}))) as T;
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
    return (await fetch(url, {
      ...requestInit,
      signal: signal || controller?.signal,
    })) as Response;
  } catch (error) {
    if ((error instanceof DOMException && error.name === "AbortError") || String(error || "").toLowerCase().includes("aborted")) {
      throw new Error(`Request timed out after ${timeoutMs || 0}ms`);
    }
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function getJson<T>(url: string, init: RequestInit & { timeoutMs?: number }) {
  const response = await fetchJson<T>(url, init);
  const data = await readJson<T & { message?: string; error?: string; msg?: string }>(response);
  if (!response.ok) {
    throw new Error(sanitizeUserFacingMessage(data?.msg || data?.message || data?.error || `Request failed: ${response.status}`));
  }
  return data as T;
}

export async function sendJson<T>(url: string, init: RequestInit & { timeoutMs?: number }) {
  const response = await fetchJson<T>(url, init);
  const data = await readJson<T & { message?: string; error?: string; msg?: string }>(response);
  if (!response.ok) {
    throw new Error(sanitizeUserFacingMessage(data?.msg || data?.message || data?.error || `Request failed: ${response.status}`));
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
