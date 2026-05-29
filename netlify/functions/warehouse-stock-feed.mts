import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { hashPortalToken } from "./_shared/portal-security.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

type WarehouseApiClientRow = {
  id?: string | null;
  organization_id?: string | null;
  client_name?: string | null;
  partner_name?: string | null;
  status?: string | null;
  include_zero_stock?: boolean | null;
  expose_unit_cost?: boolean | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  last_used_ip?: string | null;
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

type InventoryMovementRow = {
  warehouse_id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  brand?: string | null;
  product_code?: string | null;
  old_code?: string | null;
  description?: string | null;
  origin?: string | null;
  qty_in?: number | string | null;
  qty_out?: number | string | null;
  total_cost?: number | string | null;
  moved_at?: string | null;
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

function stockKey(row: {
  warehouse_id?: unknown;
  brand?: unknown;
  product_code?: unknown;
  old_code?: unknown;
}) {
  return [
    normalizeText(row.warehouse_id).toLowerCase(),
    normalizeBrand(row.brand),
    normalizePartCode(row.product_code),
    normalizePartCode(row.old_code),
  ].join("::");
}

function readApiKey(req: Request) {
  const headerValue = normalizeText(req.headers.get("x-api-key"));
  if (headerValue) return headerValue;
  const authHeader = normalizeText(req.headers.get("authorization"));
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return normalizeText(match?.[1]);
}

function readClientIp(req: Request) {
  const forwarded = normalizeText(req.headers.get("x-forwarded-for"));
  if (forwarded.includes(",")) return forwarded.split(",")[0].trim();
  return forwarded || normalizeText(req.headers.get("client-ip"));
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

    const apiKey = readApiKey(req);
    if (!apiKey) return json({ error: "Missing API key" }, 401);

    const apiKeyHash = await hashPortalToken(apiKey);
    const clients = await getJson<WarehouseApiClientRow[]>(
      buildRestUrl(supabaseUrl, "warehouse_api_clients", {
        select: "id,organization_id,client_name,partner_name,status,include_zero_stock,expose_unit_cost,expires_at,last_used_at,last_used_ip",
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

    const requestUrl = new URL(req.url);
    const requestedWarehouseCode = normalizeText(requestUrl.searchParams.get("warehouse_code"));
    const requestedBrand = normalizeText(requestUrl.searchParams.get("brand"));
    const requestedCode = normalizeText(requestUrl.searchParams.get("code"));
    const includeZeroRequested = requestUrl.searchParams.get("include_zero") === "true";
    const requestIp = readClientIp(req);

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
        request_ip: requestIp,
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

    const movements = await getJson<InventoryMovementRow[]>(
      buildRestUrl(supabaseUrl, "inventory_movements", {
        select: "warehouse_id,warehouse_code,warehouse_name,brand,product_code,old_code,description,origin,qty_in,qty_out,total_cost,moved_at",
        organization_id: `eq.${normalizeText(client.organization_id)}`,
        warehouse_id: buildInFilter(selectedWarehouseIds),
        order: "moved_at.desc",
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );

    const aggregated = new Map<
      string,
      {
        warehouse_id: string;
        warehouse_code: string;
        warehouse_name: string;
        brand: string;
        product_code: string;
        old_code: string;
        description: string;
        origin: string;
        on_hand_qty: number;
        stock_value: number;
        last_moved_at: string;
      }
    >();

    movements.forEach((movement) => {
      const key = stockKey(movement);
      const current = aggregated.get(key) || {
        warehouse_id: normalizeText(movement.warehouse_id),
        warehouse_code: normalizeText(movement.warehouse_code),
        warehouse_name: normalizeText(movement.warehouse_name),
        brand: normalizeText(movement.brand),
        product_code: normalizeText(movement.product_code),
        old_code: normalizeText(movement.old_code),
        description: normalizeText(movement.description),
        origin: normalizeText(movement.origin),
        on_hand_qty: 0,
        stock_value: 0,
        last_moved_at: normalizeText(movement.moved_at),
      };
      current.on_hand_qty = roundQty(current.on_hand_qty + toNumber(movement.qty_in) - toNumber(movement.qty_out));
      current.stock_value = roundMoney(current.stock_value + toNumber(movement.total_cost) * (toNumber(movement.qty_in) > 0 ? 1 : -1));
      if (!current.description && movement.description) current.description = normalizeText(movement.description);
      if (!current.origin && movement.origin) current.origin = normalizeText(movement.origin);
      if (!current.old_code && movement.old_code) current.old_code = normalizeText(movement.old_code);
      if (!current.product_code && movement.product_code) current.product_code = normalizeText(movement.product_code);
      if (normalizeText(movement.moved_at) > current.last_moved_at) current.last_moved_at = normalizeText(movement.moved_at);
      aggregated.set(key, current);
    });

    const normalizedCodeFilter = normalizePartCode(requestedCode);
    const normalizedBrandFilter = normalizeBrand(requestedBrand);
    const includeZero = Boolean(client.include_zero_stock) || includeZeroRequested;
    const exposeUnitCost = Boolean(client.expose_unit_cost);

    const items = [...aggregated.values()]
      .filter((row) => includeZero || row.on_hand_qty > 0)
      .filter((row) => !normalizedBrandFilter || normalizeBrand(row.brand) === normalizedBrandFilter)
      .filter((row) => {
        if (!normalizedCodeFilter) return true;
        return [row.product_code, row.old_code].some((value) => normalizePartCode(value).includes(normalizedCodeFilter));
      })
      .map((row) => ({
        warehouse_id: row.warehouse_id,
        warehouse_code: row.warehouse_code,
        warehouse_name: row.warehouse_name,
        brand: row.brand,
        product_code: row.product_code,
        old_code: row.old_code,
        description: row.description,
        origin: row.origin,
        on_hand_qty: roundQty(row.on_hand_qty),
        available_qty: roundQty(row.on_hand_qty),
        unit_cost: exposeUnitCost && row.on_hand_qty > 0 ? roundMoney(row.stock_value / row.on_hand_qty) : undefined,
        stock_value: exposeUnitCost ? roundMoney(row.stock_value) : undefined,
        last_moved_at: row.last_moved_at,
      }))
      .sort((left, right) => {
        if (left.warehouse_name !== right.warehouse_name) return left.warehouse_name.localeCompare(right.warehouse_name);
        if (left.brand !== right.brand) return left.brand.localeCompare(right.brand);
        return (left.product_code || left.old_code).localeCompare(right.product_code || right.old_code);
      });

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
          last_used_ip: requestIp,
          updated_at: new Date().toISOString(),
        }),
      },
    ).catch(() => null);

    await logRequest(supabaseUrl, serviceRoleKey, {
      organization_id: client.organization_id,
      client_id: client.id,
      client_name: normalizeText(client.client_name),
      partner_name: normalizeText(client.partner_name),
      request_ip: requestIp,
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
