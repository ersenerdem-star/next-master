import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildExpiredPortalSessionCookie } from "./_shared/portal-security.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  return json({ ok: true }, 200, {
    "Set-Cookie": buildExpiredPortalSessionCookie(),
  });
};

export const config: Config = {
  path: "/api/portal-logout",
  method: "POST",
};
