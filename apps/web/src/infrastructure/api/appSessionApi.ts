import { supabaseClient } from "./supabaseClient";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

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

const APP_SESSION_CACHE_KEY = "next-master-app-session-cache";

function readPersistedSession() {
  if (typeof window === "undefined") return null as AppSessionSnapshot | null;
  try {
    const raw = window.localStorage.getItem(APP_SESSION_CACHE_KEY);
    return raw ? (JSON.parse(raw) as AppSessionSnapshot) : null;
  } catch {
    return null;
  }
}

function writePersistedSession(snapshot: AppSessionSnapshot | null) {
  if (typeof window === "undefined") return;
  if (!snapshot) {
    window.localStorage.removeItem(APP_SESSION_CACHE_KEY);
    return;
  }
  window.localStorage.setItem(APP_SESSION_CACHE_KEY, JSON.stringify(snapshot));
}

let cachedSession: AppSessionSnapshot | null = readPersistedSession();

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Your session has expired. Sign in again."));
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("Your session has expired. Sign in again.");
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
    throw new Error(sanitizeUserFacingMessage(data.error || `App session request failed: ${response.status}`, "Session details could not be loaded right now."));
  }

  const next = {
    userId: String(data.user?.id || ""),
    email: String(data.user?.email || ""),
    organizationId: String(data.profile?.organization_id || ""),
    role: String(data.profile?.role || ""),
  };
  if (!next.userId || !next.organizationId) {
    throw new Error("Session details could not be loaded right now.");
  }

  cachedSession = next;
  writePersistedSession(next);
  return next;
}

export function clearCachedAppSession() {
  cachedSession = null;
  writePersistedSession(null);
}

export function getCachedAppSessionSnapshot() {
  return cachedSession;
}
