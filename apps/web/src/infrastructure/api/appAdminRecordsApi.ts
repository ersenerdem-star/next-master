import { supabaseClient } from "./supabaseClient";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

type AppAdminRecordsResponse<T> = {
  ok?: boolean;
  data?: T;
  error?: string;
};

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Your session has expired. Sign in again."));
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("Your session has expired. Sign in again.");
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
    throw new Error(sanitizeUserFacingMessage(data.error || `App admin records request failed: ${response.status}`, "The request could not be completed right now."));
  }
  return data.data as T;
}
