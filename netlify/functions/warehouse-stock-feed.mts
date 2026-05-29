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
  include_zero_stock?: boolean | null;
  expose_unit_cost?: boolean | null;
  expires_at?: string | null;
};

type WarehouseLinkRow = {
  warehouse_id?: string | null;
};

type WarehouseRow = {
  id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  warehouse_kind?: string | null;
  fulfillment_model?: string | null;
  is_active?: boolean | null;
};

type SnapshotRow = {
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  brand?: string | null;
  product_code?: string | null;
  old_code?: string | null;
  description?: string | null;
  origin?: string | null;
  on_hand_qty?: number | string | null;
  available_qty?: number | string | null;
  stock_value?: number | string | null;
  average_cost?: number | string | null;
  last_moved_at?: string | null;
};

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function normalizePartCode(value: unknown) {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeBrand(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value || "").replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundQty(value: number) {
  return Math.round(value * 100) / 100;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
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
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  try {
    const supabaseUrl = Netlify.env.get("SUPABASE_URL");
    const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Netlify environment variables for warehouse stock feed");
    }

    const apiKey = readPartnerApiKey(req);
    if (!apiKey) return json({ error: "Missing API key" }, 401);

    const apiKeyHash = await hashPortalToken(apiKey);
    const clients = await getJson<WarehouseApiClientRow[]>(
      buildRestUrl(supabaseUrl, "warehouse_api_clients", {
        select: "id,organization_id,client_name,partner_name,status,allowed_ip_list,require_hmac,include_zero_stock,expose_unit_cost,expires_at",
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

    const security = await enforcePartnerRequestSecurity(req, client, apiKey, "");
    const requestUrl = new URL(req.url);
    const requestedWarehouseCode = normalizeText(requestUrl.searchParams.get("warehouse_code"));
    const requestedBrand = normalizeText(requestUrl.searchParams.get("brand"));
    const requestedCode = normalizeText(requestUrl.searchParams.get("code"));
    const includeZeroRequested = requestUrl.searchParams.get("include_zero") === "true";

    if (!security.ok) {
      await logRequest(supabaseUrl, serviceRoleKey, {
        organization_id: client.organization_id,
        client_id: client.id,
        client_name: normalizeText(client.client_name),
        partner_name: normalizeText(client.partner_name),
        request_kind: "stock_feed",
        request_ip: security.clientIp,
        warehouse_filter: requestedWarehouseCode,
        brand_filter: requestedBrand,
        code_filter: requestedCode,
        status: security.error.toLowerCase().includes("ip") ? "forbidden" : "unauthorized",
        response_item_count: 0,
      });
      return json({ error: security.error }, security.error.toLowerCase().includes("ip") ? 403 : 401);
    }

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
    if (!allowedWarehouseIds.length) {
      await logRequest(supabaseUrl, serviceRoleKey, {
        organization_id: client.organization_id,
        client_id: client.id,
        client_name: normalizeText(client.client_name),
        partner_name: normalizeText(client.partner_name),
        request_kind: "stock_feed",
        request_ip: security.clientIp,
        warehouse_filter: requestedWarehouseCode,
        brand_filter: requestedBrand,
        code_filter: requestedCode,
        status: "forbidden",
        response_item_count: 0,
      });
      return json({ error: "No warehouses are assigned to this API client" }, 403);
    }

    const warehouseRows = await getJson<WarehouseRow[]>(
      buildRestUrl(supabaseUrl, "warehouses", {
        select: "id,warehouse_code,warehouse_name,warehouse_kind,fulfillment_model,is_active",
        organization_id: `eq.${normalizeText(client.organization_id)}`,
        id: buildInFilter(allowedWarehouseIds),
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );

    const warehouses = warehouseRows.filter((row) => row.is_active !== false && normalizeText(row.fulfillment_model) !== "dropship");
    const selectedWarehouses = requestedWarehouseCode
      ? warehouses.filter((row) => normalizeText(row.warehouse_code).toLowerCase() === requestedWarehouseCode.toLowerCase())
      : warehouses;

    const selectedWarehouseIds = selectedWarehouses.map((row) => normalizeText(row.id)).filter(Boolean);
    if (!selectedWarehouseIds.length) {
      return json({
        ok: true,
        generated_at: new Date().toISOString(),
        client_name: normalizeText(client.client_name),
        partner_name: normalizeText(client.partner_name),
        warehouse_count: 0,
        item_count: 0,
        warehouses: [],
        items: [],
      });
    }

    const snapshots = await getJson<SnapshotRow[]>(
      buildRestUrl(supabaseUrl, "warehouse_stock_snapshots", {
        select: "warehouse_id,warehouse_code,warehouse_name,brand,product_code,old_code,description,origin,on_hand_qty,available_qty,stock_value,average_cost,last_moved_at",
        organization_id: `eq.${normalizeText(client.organization_id)}`,
        warehouse_id: buildInFilter(selectedWarehouseIds),
        order: "warehouse_name.asc,brand.asc,product_code.asc",
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );

    const normalizedBrandFilter = normalizeBrand(requestedBrand);
    const normalizedCodeFilter = normalizePartCode(requestedCode);
    const includeZero = Boolean(client.include_zero_stock) || includeZeroRequested;
    const exposeUnitCost = Boolean(client.expose_unit_cost);

    const items = snapshots
      .filter((row) => includeZero || toNumber(row.on_hand_qty) > 0)
      .filter((row) => !normalizedBrandFilter || normalizeBrand(row.brand) === normalizedBrandFilter)
      .filter((row) => {
        if (!normalizedCodeFilter) return true;
        return [row.product_code, row.old_code].some((value) => normalizePartCode(value).includes(normalizedCodeFilter));
      })
      .map((row) => ({
        warehouse_id: normalizeText(row.warehouse_id),
        warehouse_code: normalizeText(row.warehouse_code),
        warehouse_name: normalizeText(row.warehouse_name),
        brand: normalizeText(row.brand),
        product_code: normalizeText(row.product_code),
        old_code: normalizeText(row.old_code),
        description: normalizeText(row.description),
        origin: normalizeText(row.origin),
        on_hand_qty: roundQty(toNumber(row.on_hand_qty)),
        available_qty: roundQty(toNumber(row.available_qty)),
        unit_cost: exposeUnitCost ? roundMoney(toNumber(row.average_cost)) : undefined,
        stock_value: exposeUnitCost ? roundMoney(toNumber(row.stock_value)) : undefined,
        last_moved_at: normalizeText(row.last_moved_at),
      }));

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
      request_kind: "stock_feed",
      request_ip: security.clientIp,
      warehouse_filter: requestedWarehouseCode,
      brand_filter: requestedBrand,
      code_filter: requestedCode,
      status: "success",
      response_item_count: items.length,
    });

    return json({
      ok: true,
      generated_at: new Date().toISOString(),
      client_name: normalizeText(client.client_name),
      partner_name: normalizeText(client.partner_name),
      warehouse_count: selectedWarehouses.length,
      item_count: items.length,
      warehouses: selectedWarehouses.map((row) => ({
        id: normalizeText(row.id),
        warehouse_code: normalizeText(row.warehouse_code),
        warehouse_name: normalizeText(row.warehouse_name),
        warehouse_kind: normalizeText(row.warehouse_kind),
      })),
      items,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Warehouse stock feed failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/warehouse-stock-feed",
  method: "GET",
};
