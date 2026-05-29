import { supabaseClient } from "./supabaseClient";

type AppSessionResponse = {
  ok?: boolean;
  user?: {
    id?: string;
    email?: string;
  };
  profile?: {
    organization_id?: string;
    role?: string;
  };
  error?: string;
};

type AppSessionSnapshot = {
  userId: string;
  email: string;
  organizationId: string;
  role: string;
};

let cachedSession: AppSessionSnapshot | null = null;

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(error.message || "Failed to read current session");
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("No authenticated session found");
  return token;
}

export async function fetchAppSession(forceRefresh = false): Promise<AppSessionSnapshot> {
  if (cachedSession && !forceRefresh) return cachedSession;

  const accessToken = await getAccessToken();
  const response = await fetch("/api/app-session", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = (await response.json().catch(() => ({}))) as AppSessionResponse;
  if (!response.ok) {
    throw new Error(data.error || `App session request failed: ${response.status}`);
  }

  const next = {
    userId: String(data.user?.id || ""),
    email: String(data.user?.email || ""),
    organizationId: String(data.profile?.organization_id || ""),
    role: String(data.profile?.role || ""),
  };
  if (!next.userId || !next.organizationId) {
    throw new Error("App session did not return required identity data");
  }

  cachedSession = next;
  return next;
}

export function clearCachedAppSession() {
  cachedSession = null;
}
