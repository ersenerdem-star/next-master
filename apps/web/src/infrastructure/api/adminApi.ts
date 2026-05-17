import { supabaseClient } from "./supabaseClient";

const resetPasswordUrl = import.meta.env.VITE_ADMIN_RESET_PASSWORD_URL || "/api/admin-reset-password";
const diagnosticsUrl = import.meta.env.VITE_ADMIN_DIAGNOSTICS_URL || "/api/admin-diagnostics";
const testEmailUrl = import.meta.env.VITE_ADMIN_TEST_EMAIL_URL || "/api/admin-test-email";

export type AdminDiagnostics = {
  runtime: {
    siteUrl: string;
    functionRegion: string;
  };
  env: {
    supabaseUrl: boolean;
    supabaseAnonKey: boolean;
    serviceRoleKey: boolean;
    resendApiKey: boolean;
    emailFrom: boolean;
    emailFromValue: string;
  };
  checks: {
    auth: { ok: boolean; detail: string };
    database: { ok: boolean; detail: string };
    email: { ok: boolean; detail: string };
  };
};

export function isPasswordResetAvailable() {
  if (typeof window === "undefined") return true;
  return !(window.location.hostname === "localhost" && resetPasswordUrl.startsWith("/api/"));
}

export async function resetOrgUserPassword(userId: string, password: string) {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session?.access_token) {
    throw new Error("No active session found");
  }

  const response = await fetch(resetPasswordUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ userId, password }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "Password reset failed");
  }
}

export async function fetchAdminDiagnostics(): Promise<AdminDiagnostics> {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session?.access_token) {
    throw new Error("No active session found");
  }

  const response = await fetch(diagnosticsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "Diagnostics request failed");
  }
  return payload as AdminDiagnostics;
}

export async function sendAdminTestEmail(email: string) {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session?.access_token) {
    throw new Error("No active session found");
  }

  const response = await fetch(testEmailUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ email }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "Test email send failed");
  }
  return payload as { ok: boolean; messageId?: string; email?: string };
}
