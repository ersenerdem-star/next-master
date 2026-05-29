import { supabaseClient } from "./supabaseClient";

type AppAdminRecordsResponse<T> = {
  ok?: boolean;
  data?: T;
  error?: string;
};

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(error.message || "Failed to read current session");
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("No authenticated session found");
  return token;
}

export async function callAppAdminRecords<T>(payload: Record<string, unknown>) {
  const accessToken = await getAccessToken();
  const response = await fetch("/api/app-admin-records", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  const data = (await response.json().catch(() => ({}))) as AppAdminRecordsResponse<T>;
  if (!response.ok) {
    throw new Error(data.error || `App admin records request failed: ${response.status}`);
  }
  return data.data as T;
}
