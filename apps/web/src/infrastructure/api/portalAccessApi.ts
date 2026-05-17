import type { PortalCredentials, PortalSnapshot } from "../../types/portalSession";

type PortalResponse = {
  ok?: boolean;
  snapshot?: PortalSnapshot;
  error?: string;
};

async function postPortalJson(path: string, credentials: PortalCredentials): Promise<PortalSnapshot> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(credentials),
  });

  const data = (await response.json().catch(() => ({}))) as PortalResponse;
  if (!response.ok || !data.snapshot) {
    const fallback =
      response.status === 404
        ? "Portal functions are not available on this runtime yet. Use Netlify dev or deployed app."
        : `Portal request failed: ${response.status}`;
    throw new Error(data.error || fallback);
  }

  return data.snapshot;
}

export async function loginPortal(credentials: PortalCredentials) {
  return postPortalJson("/api/portal-login", credentials);
}

export async function fetchPortalSnapshot(credentials: PortalCredentials) {
  return postPortalJson("/api/portal-data", credentials);
}
