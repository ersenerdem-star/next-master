import type { PortalBranding, PortalCredentials, PortalSnapshot } from "../../types/portalSession";

type PortalResponse = {
  ok?: boolean;
  snapshot?: PortalSnapshot;
  branding?: PortalBranding;
  sessionToken?: string;
  error?: string;
};

async function postPortalJson(path: string, credentials: PortalCredentials): Promise<{ snapshot: PortalSnapshot; sessionToken: string }> {
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

  return {
    snapshot: data.snapshot,
    sessionToken: String(data.sessionToken || credentials.sessionToken || ""),
  };
}

export async function loginPortal(credentials: PortalCredentials) {
  return postPortalJson("/api/portal-login", credentials);
}

export async function fetchPortalSnapshot(credentials: PortalCredentials) {
  return postPortalJson("/api/portal-data", credentials);
}

export async function fetchPortalBranding(credentials: PortalCredentials): Promise<{ branding: PortalBranding; sessionToken: string }> {
  const response = await fetch("/api/portal-branding", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(credentials),
  });

  const data = (await response.json().catch(() => ({}))) as PortalResponse;
  if (!response.ok || !data.branding) {
    const fallback =
      response.status === 404
        ? "Portal functions are not available on this runtime yet. Use Netlify dev or deployed app."
        : `Portal request failed: ${response.status}`;
    throw new Error(data.error || fallback);
  }

  return {
    branding: data.branding,
    sessionToken: String(data.sessionToken || credentials.sessionToken || ""),
  };
}
