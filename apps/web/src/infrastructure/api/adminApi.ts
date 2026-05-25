import { supabaseClient } from "./supabaseClient";

const resetPasswordUrl = import.meta.env.VITE_ADMIN_RESET_PASSWORD_URL || "/api/admin-reset-password";
const createUserUrl = import.meta.env.VITE_ADMIN_CREATE_USER_URL || "/api/admin-create-user";
const deleteUserUrl = import.meta.env.VITE_ADMIN_DELETE_USER_URL || "/api/admin-delete-user";
const diagnosticsUrl = import.meta.env.VITE_ADMIN_DIAGNOSTICS_URL || "/api/admin-diagnostics";
const testEmailUrl = import.meta.env.VITE_ADMIN_TEST_EMAIL_URL || "/api/admin-test-email";
const syncBrandCatalogUrl = import.meta.env.VITE_ADMIN_SYNC_BRAND_CATALOG_URL || "/api/admin-sync-brand-catalog";

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

async function getCallerAccessToken() {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session?.access_token) {
    throw new Error("No active session found");
  }
  return session.access_token;
}

export async function createOrgUser(input: {
  email: string;
  fullName: string;
  role: "admin" | "sales" | "viewer";
  isActive: boolean;
}) {
  const accessToken = await getCallerAccessToken();
  const response = await fetch(createUserUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(input),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "User create failed");
  }
  return payload as {
    ok: boolean;
    userId: string;
    email: string;
    role: string;
    isActive: boolean;
    welcomeEmailId?: string;
    welcomeEmailQueued?: boolean;
    welcomeEmailError?: string;
  };
}

export async function deleteOrgUser(userId: string) {
  const accessToken = await getCallerAccessToken();
  const response = await fetch(deleteUserUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ userId }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "User delete failed");
  }
  return payload as { ok: boolean; userId: string; email: string };
}

export async function fetchAdminDiagnostics(): Promise<AdminDiagnostics> {
  const accessToken = await getCallerAccessToken();

  const response = await fetch(diagnosticsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
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
  const accessToken = await getCallerAccessToken();

  const response = await fetch(testEmailUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ email }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "Test email send failed");
  }
  return payload as { ok: boolean; messageId?: string; email?: string };
}

export async function syncBrandCatalogFromSpareto(brandName: string, refreshExisting = true) {
  const accessToken = await getCallerAccessToken();

  const response = await fetch(syncBrandCatalogUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ brandName, refreshExisting }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error || "Brand catalog sync failed");
  }
  return payload as {
    ok: boolean;
    targetBrandName: string;
    listingUniqueRows: number;
    newRowsInListing: number;
    incompleteExistingRows: number;
    candidateRows: number;
    resolvedRows: number;
    errorRows: number;
    discontinuedRows: number;
    replacementRows: number;
    replacementFetchRows: number;
  };
}
