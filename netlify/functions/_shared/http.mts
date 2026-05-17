export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function readJson<T>(response: Response) {
  return (await response.json().catch(() => ({}))) as T;
}

export async function getJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const data = await readJson<T & { message?: string; error?: string; msg?: string }>(response);
  if (!response.ok) {
    throw new Error(data?.msg || data?.message || data?.error || `Request failed: ${response.status}`);
  }
  return data as T;
}

export async function sendJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const data = await readJson<T & { message?: string; error?: string; msg?: string }>(response);
  if (!response.ok) {
    throw new Error(data?.msg || data?.message || data?.error || `Request failed: ${response.status}`);
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
