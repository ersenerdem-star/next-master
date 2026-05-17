import { supabaseClient } from "./supabaseClient";

let cachedOrgId = "";

export async function getCurrentOrgId(forceRefresh = false) {
  if (cachedOrgId && !forceRefresh) return cachedOrgId;

  const { data, error } = await supabaseClient.from("profiles").select("organization_id").limit(1).maybeSingle();
  if (error) throw new Error(error.message || "Failed to resolve organization");

  const organizationId = String(data?.organization_id || "");
  if (!organizationId) throw new Error("No organization found for current user");

  cachedOrgId = organizationId;
  return organizationId;
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}
