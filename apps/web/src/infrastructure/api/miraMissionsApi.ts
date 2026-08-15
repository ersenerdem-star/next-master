import { supabaseClient } from "./supabaseClient";

export type MiraMissionStatus = "queued" | "processing" | "completed" | "partial" | "blocked" | "failed" | "cancelled";

export type MiraMission = {
  id: string;
  objective: string;
  mission_area: string;
  max_pages: number;
  delay_ms: number;
  status: MiraMissionStatus;
  execution_mode: "review_only";
  result?: unknown;
  error_message?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  bridge_client?: string | null;
  bridge_event_id?: string | null;
  bridge_protocol_version?: string | null;
  bridge_received_at?: string | null;
  origin?: "manual" | "planner";
  planner_key?: string | null;
  planner_score?: number | null;
  planner_reason?: string | null;
  planner_context?: Record<string, unknown> | null;
  target_brand?: string | null;
  requested_fields?: string[] | null;
  max_items?: number | null;
};

async function accessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("Your session has expired. Sign in again.");
  return data.session.access_token;
}

async function request<T>(init?: RequestInit, path = "/api/mira-missions") {
  const token = await accessToken();
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "MIRA online request failed.");
  return body;
}

export async function listMiraMissions() {
  const response = await request<{ missions?: MiraMission[] }>();
  return response.missions || [];
}

export async function queueMiraMission(input: { objective: string; missionArea: string; maxPages: number; delayMs: number }) {
  return request<{ mission: MiraMission }>({ method: "POST", body: JSON.stringify(input) });
}

export async function planMiraMissions() {
  return request<{ planner?: Record<string, unknown>; mission?: MiraMission }>({ method: "POST", body: "{}" }, "/api/mira-missions?planner=run");
}
