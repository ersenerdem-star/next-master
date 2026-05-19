import { supabaseClient } from "./supabaseClient";
import type { OrgUser } from "../../types/users";

export async function fetchOrgUsers(): Promise<OrgUser[]> {
  const { data, error } = await supabaseClient.rpc("admin_list_org_users");

  if (error) {
    throw new Error(error.message || "Failed to load users");
  }

  return (data || []) as OrgUser[];
}

export async function touchCurrentUserPresence() {
  const { error } = await supabaseClient.rpc("touch_user_presence");
  if (error) {
    throw new Error(error.message || "Failed to update presence");
  }
}

export function getPresenceStatus(lastSeenAt: string | null) {
  if (!lastSeenAt) return { tone: "offline", label: "Offline" };

  const lastSeen = new Date(lastSeenAt).getTime();
  const ageMinutes = (Date.now() - lastSeen) / 60000;
  if (ageMinutes <= 15) return { tone: "online", label: "Online now" };
  if (ageMinutes <= 120) return { tone: "recent", label: "Recently active" };
  return { tone: "offline", label: "Offline" };
}
