import type { PortalBranding, PortalCredentials, PortalSnapshot } from "../../types/portalSession";

type PortalResponse = {
  ok?: boolean;
  snapshot?: PortalSnapshot;
  branding?: PortalBranding;
  message?: string;
  error?: string;
};

async function postPortalJson(path: string, credentials: PortalCredentials): Promise<{ snapshot: PortalSnapshot }> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
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
  };
}

export async function loginPortal(credentials: PortalCredentials) {
  return postPortalJson("/api/portal-login", credentials);
}

export async function fetchPortalSnapshot(credentials: PortalCredentials) {
  return postPortalJson("/api/portal-data", credentials);
}

export async function fetchPortalBranding(credentials: PortalCredentials): Promise<{ branding: PortalBranding }> {
  const response = await fetch("/api/portal-branding", {
    method: "POST",
    credentials: "same-origin",
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
  };
}

export async function requestPortalPasswordReset(email: string) {
  const response = await fetch("/api/portal-password-reset-request", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });

  const data = (await response.json().catch(() => ({}))) as PortalResponse;
  if (!response.ok) {
    const fallback =
      response.status === 404
        ? "Portal functions are not available on this runtime yet. Use Netlify dev or deployed app."
        : `Portal request failed: ${response.status}`;
    throw new Error(data.error || fallback);
  }
  return {
    ok: true,
    message: String(data.message || "If the portal email exists, a reset link has been sent."),
  };
}

export async function confirmPortalPasswordReset(email: string, resetToken: string, password: string) {
  const response = await fetch("/api/portal-password-reset-confirm", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      resetToken,
      password,
    }),
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
  };
}

export async function logoutPortalSession() {
  await fetch("/api/portal-logout", {
    method: "POST",
    credentials: "same-origin",
  }).catch(() => undefined);
}
