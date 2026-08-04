import { supabaseClient } from "./supabaseClient";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

type RpcResponse<T> = {
  ok?: boolean;
  data?: T;
  error?: string;
};

const APP_RPC_TIMEOUT_MS = 15_000;

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Your session has expired. Sign in again."));
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("Your session has expired. Sign in again.");
  return token;
}

export async function callAppRpc<T>(name: string, args: Record<string, unknown> = {}) {
  const accessToken = await getAccessToken();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), APP_RPC_TIMEOUT_MS);
  try {
    const response = await fetch("/api/app-rpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ name, args }),
      signal: controller.signal,
    });
    const data = (await response.json()) as RpcResponse<T>;
    if (!response.ok) {
      throw new Error(sanitizeUserFacingMessage(data.error || `App RPC failed: ${response.status}`, "The request could not be completed right now."));
    }
    return data.data as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("The request timed out. Please try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}
