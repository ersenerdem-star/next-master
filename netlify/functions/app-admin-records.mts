import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { resolveCaller } from "./_shared/app-auth.mts";
import { canAccessCustomerOps, canAccessOperationsModules, isSuperadminRole } from "./_shared/roles.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const CUSTOMER_COLUMNS = [
  "id",
  "customer_type",
  "salutation",
  "first_name",
  "last_name",
  "company_name",
  "display_name",
  "email",
  "customer_number",
  "work_phone",
  "mobile_phone",
  "language",
  "tax_rate",
  "company_id",
  "currency",
  "payment_terms",
  "contract_nr",
  "seller_company_profile_id",
  "price_list_type",
  "portal_c_price_mode",
  "price_list_margin_percent",
  "billing_address",
  "shipping_address",
  "contact_persons",
  "custom_fields",
  "reporting_tags",
  "remarks",
  "created_at",
  "updated_at",
].join(",");

const LEGACY_CUSTOMER_COLUMNS = [
  "id",
  "customer_type",
  "salutation",
  "first_name",
  "last_name",
  "company_name",
  "display_name",
  "email",
  "customer_number",
  "work_phone",
  "mobile_phone",
  "language",
  "tax_rate",
  "company_id",
  "currency",
  "payment_terms",
  "contract_nr",
  "price_list_type",
  "billing_address",
  "shipping_address",
  "contact_persons",
  "custom_fields",
  "reporting_tags",
  "remarks",
  "created_at",
  "updated_at",
].join(",");

const VENDOR_COLUMNS = [
  "id",
  "vendor_type",
  "salutation",
  "first_name",
  "last_name",
  "company_name",
  "display_name",
  "email",
  "vendor_number",
  "work_phone",
  "mobile_phone",
  "language",
  "tax_rate",
  "company_id",
  "currency",
  "payment_terms",
  "billing_address",
  "shipping_address",
  "contact_persons",
  "custom_fields",
  "reporting_tags",
  "remarks",
  "created_at",
  "updated_at",
].join(",");

const COMPANY_PROFILE_COLUMNS = [
  "id",
  "company_name",
  "email",
  "phone",
  "website",
  "address",
  "bank_details",
  "tax_office",
  "tax_number",
  "footer_note",
  "logo_data_url",
].join(",");

const PORTAL_INVITE_COLUMNS = [
  "id",
  "party_type",
  "party_name",
  "customer_id",
  "vendor_id",
  "email",
  "contact_name",
  "status",
  "last_sent_at",
  "expires_at",
  "access_can_view_account",
  "access_can_view_invoices",
  "access_can_view_payments",
  "access_can_view_orders",
  "created_at",
  "updated_at",
].join(",");

const LEGACY_PORTAL_INVITE_COLUMNS = [
  "id",
  "party_type",
  "party_name",
  "email",
  "contact_name",
  "status",
  "invite_token",
  "last_sent_at",
  "access_can_view_account",
  "access_can_view_invoices",
  "access_can_view_payments",
  "access_can_view_orders",
  "created_at",
  "updated_at",
].join(",");

const PORTAL_TOKEN_TTL_DAYS = 14;
const CUSTOMER_META_PREFIX = "[[NEXT_MASTER_META]]";
const BRAND_COLUMNS = ["id", "name"].join(",");

function encodeHex(input: ArrayBuffer) {
  return Array.from(new Uint8Array(input))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function generatePortalToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashPortalToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return encodeHex(digest);
}

function buildExpiryIso() {
  const value = new Date();
  value.setDate(value.getDate() + PORTAL_TOKEN_TTL_DAYS);
  return value.toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function getErrorMessage(error: unknown, fallback: string) {
  return sanitizeUserFacingError(error, fallback);
}

function parseEmbeddedCustomerMeta(raw: unknown) {
  const text = String(raw || "");
  const markerIndex = text.lastIndexOf(CUSTOMER_META_PREFIX);
  if (markerIndex < 0) return { clean: text, meta: {} as Record<string, unknown> };
  const clean = text.slice(0, markerIndex).trimEnd();
  const jsonText = text.slice(markerIndex + CUSTOMER_META_PREFIX.length).trim();
  try {
    return { clean, meta: (JSON.parse(jsonText) as Record<string, unknown>) || {} };
  } catch {
    return { clean: text, meta: {} as Record<string, unknown> };
  }
}

function embedCustomerMeta(raw: unknown, metaPatch: {
  seller_company_profile_id?: string | null;
  price_list_type?: string | null;
  portal_c_price_mode?: string | null;
  price_list_margin_percent?: unknown;
}) {
  const parsed = parseEmbeddedCustomerMeta(raw);
  const nextMeta: Record<string, unknown> = {};
  if (typeof metaPatch.seller_company_profile_id === "string" && metaPatch.seller_company_profile_id.trim()) {
    nextMeta.seller_company_profile_id = metaPatch.seller_company_profile_id.trim();
  }
  if (typeof metaPatch.price_list_type === "string" && metaPatch.price_list_type.trim()) {
    nextMeta.price_list_type = metaPatch.price_list_type.trim();
  }
  if (typeof metaPatch.portal_c_price_mode === "string" && metaPatch.portal_c_price_mode.trim()) {
    nextMeta.portal_c_price_mode = metaPatch.portal_c_price_mode.trim();
  }
  if (metaPatch.price_list_margin_percent != null && Number.isFinite(Number(metaPatch.price_list_margin_percent))) {
    nextMeta.price_list_margin_percent = Number(metaPatch.price_list_margin_percent);
  }
  if (!Object.keys(nextMeta).length) return parsed.clean;
  const encoded = `${CUSTOMER_META_PREFIX}${JSON.stringify(nextMeta)}`;
  return parsed.clean ? `${parsed.clean}\n${encoded}` : encoded;
}

async function sanitizeCustomerPayload(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  payload: Record<string, unknown>;
}) {
  const next = { ...input.payload };
  const rawProfileId = String(next.seller_company_profile_id || "").trim();
  if (!rawProfileId || !isUuid(rawProfileId)) {
    next.seller_company_profile_id = null;
    next.custom_fields = embedCustomerMeta(next.custom_fields, {
      seller_company_profile_id: null,
      price_list_type: String(next.price_list_type || ""),
      portal_c_price_mode: String(next.portal_c_price_mode || "standard"),
      price_list_margin_percent: next.price_list_margin_percent,
    });
    return next;
  }

  const profile = await getJson<Array<Record<string, unknown>>>(
    buildRestUrl(input.supabaseUrl, "company_profiles", {
      select: "id",
      organization_id: `eq.${input.organizationId}`,
      id: `eq.${rawProfileId}`,
      limit: "1",
    }),
    {
      headers: serviceRoleHeaders(input.serviceRoleKey),
    },
  ).catch(() => []);

  next.seller_company_profile_id = profile[0]?.id ? rawProfileId : null;
  next.custom_fields = embedCustomerMeta(next.custom_fields, {
    seller_company_profile_id: String(next.seller_company_profile_id || ""),
    price_list_type: String(next.price_list_type || ""),
    portal_c_price_mode: String(next.portal_c_price_mode || "standard"),
    price_list_margin_percent: next.price_list_margin_percent,
  });
  return next;
}

async function listRows<T>(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  table: string;
  select: string;
  organizationId: string;
  order: string;
}) {
  return getJson<T[]>(
    buildRestUrl(input.supabaseUrl, input.table, {
      select: input.select,
      organization_id: `eq.${input.organizationId}`,
      order: input.order,
    }),
    {
      headers: serviceRoleHeaders(input.serviceRoleKey),
    },
  );
}

async function updateSingleRow<T>(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  table: string;
  select: string;
  organizationId: string;
  id: string;
  payload: Record<string, unknown>;
}) {
  return sendJson<T[]>(
    buildRestUrl(input.supabaseUrl, input.table, {
      select: input.select,
      id: `eq.${input.id}`,
      organization_id: `eq.${input.organizationId}`,
      limit: "1",
    }),
    {
      method: "PATCH",
      headers: {
        ...serviceRoleHeaders(input.serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify(input.payload),
    },
  );
}

async function insertSingleRow<T>(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  table: string;
  select: string;
  payload: Record<string, unknown>;
}) {
  return sendJson<T[]>(
    buildRestUrl(input.supabaseUrl, input.table, {
      select: input.select,
    }),
    {
      method: "POST",
      headers: {
        ...serviceRoleHeaders(input.serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify([input.payload]),
    },
  );
}

async function deleteSingleRow(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  table: string;
  organizationId: string;
  id: string;
}) {
  await sendJson<unknown>(
    buildRestUrl(input.supabaseUrl, input.table, {
      id: `eq.${input.id}`,
      organization_id: `eq.${input.organizationId}`,
    }),
    {
      method: "DELETE",
      headers: {
        ...serviceRoleHeaders(input.serviceRoleKey),
        Prefer: "return=minimal",
      },
    },
  );
}

async function listPortalInvites(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  try {
    return await listRows<Record<string, unknown>>({
      supabaseUrl,
      serviceRoleKey,
      table: "portal_invites",
      select: PORTAL_INVITE_COLUMNS,
      organizationId,
      order: "updated_at.desc",
    });
  } catch (primaryError) {
    try {
      return await listRows<Record<string, unknown>>({
        supabaseUrl,
        serviceRoleKey,
        table: "portal_invites",
        select: LEGACY_PORTAL_INVITE_COLUMNS,
        organizationId,
        order: "updated_at.desc",
      });
    } catch (legacyError) {
      throw new Error(getErrorMessage(legacyError, getErrorMessage(primaryError, "Portal invites load failed")));
    }
  }
}

function stripCustomerOptionalFields(payload: Record<string, unknown>) {
  const next = { ...payload };
  delete next.seller_company_profile_id;
  delete next.portal_c_price_mode;
  delete next.price_list_margin_percent;
  return next;
}

async function listCustomers(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  try {
    return await listRows<Record<string, unknown>>({
      supabaseUrl,
      serviceRoleKey,
      table: "customers",
      select: CUSTOMER_COLUMNS,
      organizationId,
      order: "display_name.asc",
    });
  } catch (primaryError) {
    try {
      return await listRows<Record<string, unknown>>({
        supabaseUrl,
        serviceRoleKey,
        table: "customers",
        select: LEGACY_CUSTOMER_COLUMNS,
        organizationId,
        order: "display_name.asc",
      });
    } catch (legacyError) {
      throw new Error(getErrorMessage(legacyError, getErrorMessage(primaryError, "Customers load failed")));
    }
  }
}

async function upsertCustomerRecord(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  payload: Record<string, unknown>;
  id: string;
}) {
  const runWith = async (select: string, payload: Record<string, unknown>) => {
    if (input.id) {
      const rows = await updateSingleRow<Record<string, unknown>>({
        supabaseUrl: input.supabaseUrl,
        serviceRoleKey: input.serviceRoleKey,
        table: "customers",
        select,
        organizationId: input.organizationId,
        id: input.id,
        payload,
      });
      return rows[0] || null;
    }
    const rows = await insertSingleRow<Record<string, unknown>>({
      supabaseUrl: input.supabaseUrl,
      serviceRoleKey: input.serviceRoleKey,
      table: "customers",
      select,
      payload,
    });
    return rows[0] || null;
  };

  try {
    return await runWith(CUSTOMER_COLUMNS, input.payload);
  } catch (primaryError) {
    const primaryMessage = getErrorMessage(primaryError, "Customer save failed").toLowerCase();
    if (primaryMessage.includes("seller_company_profile_id") || primaryMessage.includes("company profile")) {
      const retryPayload = { ...input.payload, seller_company_profile_id: null };
      try {
        return await runWith(CUSTOMER_COLUMNS, retryPayload);
      } catch (retryError) {
        throw new Error(getErrorMessage(retryError, getErrorMessage(primaryError, "Customer save failed")));
      }
    }

    try {
      return await runWith(LEGACY_CUSTOMER_COLUMNS, stripCustomerOptionalFields(input.payload));
    } catch (legacyError) {
      throw new Error(getErrorMessage(legacyError, getErrorMessage(primaryError, "Customer save failed")));
    }
  }
}

async function upsertPortalInvite(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  payload: Record<string, unknown>;
  id: string;
}) {
  if (input.id) {
    try {
      const rows = await updateSingleRow<Record<string, unknown>>({
        supabaseUrl: input.supabaseUrl,
        serviceRoleKey: input.serviceRoleKey,
        table: "portal_invites",
        select: PORTAL_INVITE_COLUMNS,
        organizationId: input.organizationId,
        id: input.id,
        payload: input.payload,
      });
      return rows[0] || null;
    } catch (primaryError) {
      const legacyPayload = { ...input.payload };
      delete legacyPayload.customer_id;
      delete legacyPayload.vendor_id;
      delete legacyPayload.expires_at;
      const rows = await updateSingleRow<Record<string, unknown>>({
        supabaseUrl: input.supabaseUrl,
        serviceRoleKey: input.serviceRoleKey,
        table: "portal_invites",
        select: LEGACY_PORTAL_INVITE_COLUMNS,
        organizationId: input.organizationId,
        id: input.id,
        payload: legacyPayload,
      }).catch((legacyError) => {
        throw new Error(getErrorMessage(legacyError, getErrorMessage(primaryError, "Portal invite save failed")));
      });
      return rows[0] || null;
    }
  }

  try {
    const rows = await insertSingleRow<Record<string, unknown>>({
      supabaseUrl: input.supabaseUrl,
      serviceRoleKey: input.serviceRoleKey,
      table: "portal_invites",
      select: PORTAL_INVITE_COLUMNS,
      payload: input.payload,
    });
    return rows[0] || null;
  } catch (primaryError) {
    const legacyPayload = { ...input.payload };
    delete legacyPayload.customer_id;
    delete legacyPayload.vendor_id;
    delete legacyPayload.expires_at;
    const rows = await insertSingleRow<Record<string, unknown>>({
      supabaseUrl: input.supabaseUrl,
      serviceRoleKey: input.serviceRoleKey,
      table: "portal_invites",
      select: LEGACY_PORTAL_INVITE_COLUMNS,
      payload: legacyPayload,
    }).catch((legacyError) => {
      throw new Error(getErrorMessage(legacyError, getErrorMessage(primaryError, "Portal invite create failed")));
    });
    return rows[0] || null;
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    const body = await req.json().catch(() => ({}));
    const resource = String(body?.resource || "").trim();
    const action = String(body?.action || "").trim();
    const payload = isObject(body?.payload) ? body.payload : {};
    const id = String(body?.id || "").trim();
    const canUseCustomerRecords = canAccessCustomerOps(caller.role);
    const canUseOperationsModules = canAccessOperationsModules(caller.role);
    const isSuperadmin = isSuperadminRole(caller.role);

    if (resource === "customers") {
      if (!canUseCustomerRecords) return json({ error: "Staff access required" }, 403);
      if (action === "list") {
        const data = await listCustomers(supabaseUrl, serviceRoleKey, caller.organizationId);
        return json({ ok: true, data });
      }
      if (action === "upsert") {
        const nextPayload = await sanitizeCustomerPayload({
          supabaseUrl,
          serviceRoleKey,
          organizationId: caller.organizationId,
          payload,
        });
        const data = await upsertCustomerRecord({
          supabaseUrl,
          serviceRoleKey,
          organizationId: caller.organizationId,
          payload: nextPayload,
          id,
        });
        return json({ ok: true, data });
      }
      if (action === "delete") {
        await deleteSingleRow({ supabaseUrl, serviceRoleKey, table: "customers", organizationId: caller.organizationId, id });
        return json({ ok: true, data: true });
      }
    }

    if (resource === "vendors") {
      if (!canUseOperationsModules) return json({ error: "Operations access required" }, 403);
      if (action === "list") {
        const data = await listRows<Record<string, unknown>>({
          supabaseUrl,
          serviceRoleKey,
          table: "vendors",
          select: VENDOR_COLUMNS,
          organizationId: caller.organizationId,
          order: "display_name.asc",
        });
        return json({ ok: true, data });
      }
      if (action === "upsert") {
        const data = id
          ? (
              await updateSingleRow<Record<string, unknown>>({
                supabaseUrl,
                serviceRoleKey,
                table: "vendors",
                select: VENDOR_COLUMNS,
                organizationId: caller.organizationId,
                id,
                payload,
              })
            )[0] || null
          : (
              await insertSingleRow<Record<string, unknown>>({
                supabaseUrl,
                serviceRoleKey,
                table: "vendors",
                select: VENDOR_COLUMNS,
                payload,
              })
            )[0] || null;
        return json({ ok: true, data });
      }
      if (action === "delete") {
        if (!canUseOperationsModules) return json({ error: "Operations access required" }, 403);
        await deleteSingleRow({ supabaseUrl, serviceRoleKey, table: "vendors", organizationId: caller.organizationId, id });
        return json({ ok: true, data: true });
      }
    }

    if (resource === "companyProfiles") {
      if (!canUseCustomerRecords) return json({ error: "Staff access required" }, 403);
      if (action === "list") {
        const data = await listRows<Record<string, unknown>>({
          supabaseUrl,
          serviceRoleKey,
          table: "company_profiles",
          select: COMPANY_PROFILE_COLUMNS,
          organizationId: caller.organizationId,
          order: "company_name.asc",
        });
        return json({ ok: true, data });
      }
      if (action === "upsert") {
        if (!isSuperadmin) return json({ error: "Superadmin access required" }, 403);
        const data = id
          ? (
              await updateSingleRow<Record<string, unknown>>({
                supabaseUrl,
                serviceRoleKey,
                table: "company_profiles",
                select: COMPANY_PROFILE_COLUMNS,
                organizationId: caller.organizationId,
                id,
                payload,
              })
            )[0] || null
          : (
              await insertSingleRow<Record<string, unknown>>({
                supabaseUrl,
                serviceRoleKey,
                table: "company_profiles",
                select: COMPANY_PROFILE_COLUMNS,
                payload,
              })
            )[0] || null;
        return json({ ok: true, data });
      }
      if (action === "delete") {
        if (!isSuperadmin) return json({ error: "Superadmin access required" }, 403);
        await deleteSingleRow({ supabaseUrl, serviceRoleKey, table: "company_profiles", organizationId: caller.organizationId, id });
        return json({ ok: true, data: true });
      }
    }

    if (resource === "portalInvites") {
      if (!canUseCustomerRecords) return json({ error: "Staff access required" }, 403);
      if (action === "list") {
        const data = await listPortalInvites(supabaseUrl, serviceRoleKey, caller.organizationId);
        return json({ ok: true, data });
      }
      if (action === "upsert") {
        const data = await upsertPortalInvite({
          supabaseUrl,
          serviceRoleKey,
          organizationId: caller.organizationId,
          payload,
          id,
        });
        return json({ ok: true, data });
      }
      if (action === "delete") {
        await deleteSingleRow({ supabaseUrl, serviceRoleKey, table: "portal_invites", organizationId: caller.organizationId, id });
        return json({ ok: true, data: true });
      }
      if (action === "issueToken") {
        const token = generatePortalToken();
        const tokenHash = await hashPortalToken(token);
        const expiresAt = buildExpiryIso();
        const rows = await updateSingleRow<Record<string, unknown>>({
          supabaseUrl,
          serviceRoleKey,
          table: "portal_invites",
          select: PORTAL_INVITE_COLUMNS,
          organizationId: caller.organizationId,
          id,
          payload: {
            invite_token: null,
            invite_token_hash: tokenHash,
            expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          },
        });
        return json({
          ok: true,
          data: {
            invite: rows[0] || null,
            token,
          },
        });
      }
      if (action === "markSent") {
        const rows = await updateSingleRow<Record<string, unknown>>({
          supabaseUrl,
          serviceRoleKey,
          table: "portal_invites",
          select: PORTAL_INVITE_COLUMNS,
          organizationId: caller.organizationId,
          id,
          payload: {
            status: "invited",
            last_sent_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }).catch(async (primaryError) => {
          const legacyRows = await updateSingleRow<Record<string, unknown>>({
            supabaseUrl,
            serviceRoleKey,
            table: "portal_invites",
            select: LEGACY_PORTAL_INVITE_COLUMNS,
            organizationId: caller.organizationId,
            id,
            payload: {
              status: "invited",
              last_sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          }).catch((legacyError) => {
            throw new Error(getErrorMessage(legacyError, getErrorMessage(primaryError, "Portal invite send failed")));
          });
          return legacyRows;
        });
        return json({ ok: true, data: rows[0] || null });
      }
      if (action === "setStatus") {
        const status = String(body?.status || "").trim();
        const rows = await updateSingleRow<Record<string, unknown>>({
          supabaseUrl,
          serviceRoleKey,
          table: "portal_invites",
          select: PORTAL_INVITE_COLUMNS,
          organizationId: caller.organizationId,
          id,
          payload: {
            status,
            updated_at: new Date().toISOString(),
          },
        }).catch(async (primaryError) => {
          const legacyRows = await updateSingleRow<Record<string, unknown>>({
            supabaseUrl,
            serviceRoleKey,
            table: "portal_invites",
            select: LEGACY_PORTAL_INVITE_COLUMNS,
            organizationId: caller.organizationId,
            id,
            payload: {
              status,
              updated_at: new Date().toISOString(),
            },
          }).catch((legacyError) => {
            throw new Error(getErrorMessage(legacyError, getErrorMessage(primaryError, "Portal invite status update failed")));
          });
          return legacyRows;
        });
        return json({ ok: true, data: rows[0] || null });
      }
    }

    if (resource === "brands") {
      if (!canUseCustomerRecords) return json({ error: "Staff access required" }, 403);
      if (action === "list") {
        const data = await listRows<Record<string, unknown>>({
          supabaseUrl,
          serviceRoleKey,
          table: "brands",
          select: BRAND_COLUMNS,
          organizationId: caller.organizationId,
          order: "name.asc",
        });
        return json({ ok: true, data });
      }
    }

    return json({ error: "Unsupported admin records request" }, 400);
  } catch (error) {
    return json({ error: getErrorMessage(error, "App admin records request failed") }, 400);
  }
};

export const config: Config = {
  path: "/api/app-admin-records",
  method: "POST",
};
