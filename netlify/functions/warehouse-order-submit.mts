import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { hashPortalToken } from "./_shared/portal-security.mts";
import { enforcePartnerRequestSecurity, readPartnerApiKey } from "./_shared/warehouse-partner-auth.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

type WarehouseApiClientRow = {
  id?: string | null;
  organization_id?: string | null;
  client_name?: string | null;
  partner_name?: string | null;
  status?: string | null;
  allowed_ip_list?: string | null;
  require_hmac?: boolean | null;
  allow_order_submit?: boolean | null;
  expires_at?: string | null;
};

type WarehouseLinkRow = {
  warehouse_id?: string | null;
};

type WarehouseRow = {
  id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  fulfillment_model?: string | null;
  is_active?: boolean | null;
};

type OrderLineInput = {
  warehouse_code?: string;
  brand?: string;
  product_code?: string;
  old_code?: string;
  qty?: number | string;
  notes?: string;
};

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value || "").replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpired(expiresAt: string | null | undefined) {
  const raw = normalizeText(expiresAt);
  if (!raw) return false;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < Date.now();
}

function buildInFilter(ids: string[]) {
  return `in.(${ids.join(",")})`;
}

function buildRequestNo() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `APIORD-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

async function logRequest(
  supabaseUrl: string,
  serviceRoleKey: string,
  payload: Record<string, unknown>,
) {
  await sendJson<unknown>(`${supabaseUrl}/rest/v1/warehouse_api_request_logs`, {
    method: "POST",
    headers: {
      ...serviceRoleHeaders(serviceRoleKey),
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  }).catch(() => null);
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Netlify.env.get("SUPABASE_URL");
    const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Netlify environment variables for warehouse order submit");
    }

    const apiKey = readPartnerApiKey(req);
    if (!apiKey) return json({ error: "Missing API key" }, 401);

    const bodyText = await req.text();
    const apiKeyHash = await hashPortalToken(apiKey);
    const clients = await getJson<WarehouseApiClientRow[]>(
      buildRestUrl(supabaseUrl, "warehouse_api_clients", {
        select: "id,organization_id,client_name,partner_name,status,allowed_ip_list,require_hmac,allow_order_submit,expires_at",
        api_key_hash: `eq.${apiKeyHash}`,
        status: "eq.active",
        limit: "1",
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );

    const client = clients[0];
    if (!client?.id || !client.organization_id) return json({ error: "Invalid API key" }, 401);
    if (isExpired(client.expires_at)) return json({ error: "API key has expired" }, 401);

    const security = await enforcePartnerRequestSecurity(req, client, apiKey, bodyText);
    if (!security.ok) {
      await logRequest(supabaseUrl, serviceRoleKey, {
        organization_id: client.organization_id,
        client_id: client.id,
        client_name: normalizeText(client.client_name),
        partner_name: normalizeText(client.partner_name),
        request_kind: "order_submit",
        request_ip: security.clientIp,
        status: security.error.toLowerCase().includes("ip") ? "forbidden" : "unauthorized",
        response_item_count: 0,
      });
      return json({ error: security.error }, security.error.toLowerCase().includes("ip") ? 403 : 401);
    }

    if (client.allow_order_submit !== true) {
      await logRequest(supabaseUrl, serviceRoleKey, {
        organization_id: client.organization_id,
        client_id: client.id,
        client_name: normalizeText(client.client_name),
        partner_name: normalizeText(client.partner_name),
        request_kind: "order_submit",
        request_ip: security.clientIp,
        status: "forbidden",
        response_item_count: 0,
      });
      return json({ error: "Order submit endpoint is not enabled for this API client." }, 403);
    }

    const payload = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    const lines = Array.isArray(payload.lines) ? (payload.lines as OrderLineInput[]) : [];
    if (!lines.length) return json({ error: "At least one order line is required." }, 400);

    const links = await getJson<WarehouseLinkRow[]>(
      buildRestUrl(supabaseUrl, "warehouse_api_client_warehouses", {
        select: "warehouse_id",
        organization_id: `eq.${normalizeText(client.organization_id)}`,
        client_id: `eq.${normalizeText(client.id)}`,
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );

    const allowedWarehouseIds = [...new Set(links.map((row) => normalizeText(row.warehouse_id)).filter(Boolean))];
    const warehouseRows = allowedWarehouseIds.length
      ? await getJson<WarehouseRow[]>(
          buildRestUrl(supabaseUrl, "warehouses", {
            select: "id,warehouse_code,warehouse_name,fulfillment_model,is_active",
            organization_id: `eq.${normalizeText(client.organization_id)}`,
            id: buildInFilter(allowedWarehouseIds),
          }),
          {
            headers: serviceRoleHeaders(serviceRoleKey),
          },
        )
      : [];
    const warehouseByCode = new Map(
      warehouseRows
        .filter((row) => row.is_active !== false && normalizeText(row.fulfillment_model) !== "dropship")
        .map((row) => [normalizeText(row.warehouse_code).toLowerCase(), row]),
    );

    const cleanedLines = lines.map((line, index) => {
      const qty = toNumber(line.qty);
      if (qty <= 0) {
        throw new Error(`Line ${index + 1} quantity must be greater than zero.`);
      }
      const productCode = normalizeText(line.product_code);
      const oldCode = normalizeText(line.old_code);
      if (!productCode && !oldCode) {
        throw new Error(`Line ${index + 1} requires product code or old code.`);
      }
      const warehouseCode = normalizeText(line.warehouse_code);
      if (warehouseCode && !warehouseByCode.has(warehouseCode.toLowerCase())) {
        throw new Error(`Warehouse code ${warehouseCode} is not allowed for this API client.`);
      }
      return {
        warehouse_code: warehouseCode,
        warehouse_name: warehouseCode ? normalizeText(warehouseByCode.get(warehouseCode.toLowerCase())?.warehouse_name) : "",
        brand: normalizeText(line.brand),
        product_code: productCode,
        old_code: oldCode,
        qty,
        notes: normalizeText(line.notes),
      };
    });

    const requestNo = buildRequestNo();
    const createdRows = await sendJson<Array<{ id?: string | null; request_no?: string | null; status?: string | null }>>(
      `${supabaseUrl}/rest/v1/warehouse_api_order_requests`,
      {
        method: "POST",
        headers: {
          ...serviceRoleHeaders(serviceRoleKey),
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          organization_id: client.organization_id,
          client_id: client.id,
          client_name: normalizeText(client.client_name),
          partner_name: normalizeText(client.partner_name),
          request_no: requestNo,
          status: "submitted",
          buyer_reference: normalizeText(payload.buyer_reference),
          requested_currency: normalizeText(payload.requested_currency) || "EUR",
          requested_delivery_date: normalizeText(payload.requested_delivery_date) || null,
          ship_to_name: normalizeText(payload.ship_to_name),
          ship_to_address: normalizeText(payload.ship_to_address),
          contact_name: normalizeText(payload.contact_name),
          contact_email: normalizeText(payload.contact_email),
          contact_phone: normalizeText(payload.contact_phone),
          notes: normalizeText(payload.notes),
          lines: cleanedLines,
          raw_payload: payload,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      },
    );

    const created = createdRows[0] || {};

    await sendJson<unknown>(
      buildRestUrl(supabaseUrl, "warehouse_api_clients", {
        id: `eq.${normalizeText(client.id)}`,
        organization_id: `eq.${normalizeText(client.organization_id)}`,
      }),
      {
        method: "PATCH",
        headers: {
          ...serviceRoleHeaders(serviceRoleKey),
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          last_used_at: new Date().toISOString(),
          last_used_ip: security.clientIp,
          updated_at: new Date().toISOString(),
        }),
      },
    ).catch(() => null);

    await logRequest(supabaseUrl, serviceRoleKey, {
      organization_id: client.organization_id,
      client_id: client.id,
      client_name: normalizeText(client.client_name),
      partner_name: normalizeText(client.partner_name),
      request_kind: "order_submit",
      request_ip: security.clientIp,
      status: "success",
      response_item_count: cleanedLines.length,
    });

    return json({
      ok: true,
      request_id: normalizeText(created.id),
      request_no: normalizeText(created.request_no) || requestNo,
      status: normalizeText(created.status) || "submitted",
      line_count: cleanedLines.length,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Warehouse order submit failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/warehouse-order-submit",
  method: "POST",
};
