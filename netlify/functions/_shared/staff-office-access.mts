import { getContext } from "@netlify/functions";
import { BlockList, isIP } from "node:net";
import { buildRestUrl, getJson, serviceRoleHeaders } from "./http.mts";

export class OfficeNetworkRequiredError extends Error {
  readonly status = 403;
  constructor() {
    super("Bu hesap yalnızca tanımlı ofis ağından kullanılabilir.");
    this.name = "OfficeNetworkRequiredError";
  }
}

export function isAllowedOfficeIp(clientIp: string, allowedIps: string[]) {
  const ip = clientIp.trim();
  const family = isIP(ip);
  if (!family) return false;
  const kind = family === 4 ? "ipv4" : "ipv6";
  return allowedIps.some((allowed) => {
    if (isIP(allowed) !== family) return false;
    const list = new BlockList();
    list.addAddress(allowed, kind);
    return list.check(ip, kind);
  });
}

export async function enforceStaffOfficeAccess(
  supabaseUrl: string,
  serviceRoleKey: string,
  profileId: string,
  role: string,
) {
  if (role === "admin" || role === "superadmin") return;
  const rows = await getJson<Array<{ enabled: boolean; allowed_ips: string[] }>>(
    buildRestUrl(supabaseUrl, "staff_office_access", {
      select: "enabled,allowed_ips",
      profile_id: `eq.${profileId}`,
      limit: "1",
    }),
    { headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 8_000 },
  );
  if (!rows[0]?.enabled) return;

  // Netlify Context.ip is derived from the connection, unlike client-provided
  // X-Forwarded-For or Client-IP headers.
  let clientIp = "";
  try { clientIp = getContext().ip || ""; } catch { /* no trusted context: fail closed */ }
  if (!isAllowedOfficeIp(clientIp, rows[0].allowed_ips || [])) {
    throw new OfficeNetworkRequiredError();
  }
}
