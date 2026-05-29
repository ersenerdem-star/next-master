import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { hashPortalToken } from "./_shared/portal-security.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

type WarehouseApiClientRow = {
  id?: string | null;
  organization_id?: string | null;
  client_name?: string | null;
  partner_name?: string | null;
  status?: string | null;
  api_key_prefix?: string | null;
  allowed_ip_list?: string | null;
  require_hmac?: boolean | null;
  allow_order_submit?: boolean | null;
  include_zero_stock?: boolean | null;
  expose_unit_cost?: boolean | null;
  notes?: string | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  last_used_ip?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type WarehouseApiClientWarehouseRow = {
  client_id?: string | null;
  warehouse_id?: string | null;
};

type WarehouseRow = {
  id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  fulfillment_model?: string | null;
  is_active?: boolean | null;
};

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function normalizeStatus(value: unknown) {
  return String(value || "").trim().toLowerCase() === "disabled" ? "disabled" : "active";
}

function uniqueIds(values: unknown[]) {
  return [...new Set(values.map((value) => normalizeText(value)).filter((value) => isUuid(value)))];
}

function buildApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `nmwh_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function buildPrefix(apiKey: string) {
  return normalizeText(apiKey).slice(0, 14);
}

function buildInFilter(ids: string[]) {
  return `in.(${ids.join(",")})`;
}

function mapClientRow(
  row: WarehouseApiClientRow,
  linkMap: Map<string, string[]>,
  warehouseMap: Map<string, WarehouseRow>,
) {
  const clientId = normalizeText(row.id);
  const warehouseIds = linkMap.get(clientId) || [];
  return {
    id: clientId,
    client_name: normalizeText(row.client_name),
    partner_name: normalizeText(row.partner_name),
    status: normalizeStatus(row.status),
    allowed_ip_list: normalizeText(row.allowed_ip_list),
    require_hmac: row.require_hmac !== false,
    allow_order_submit: Boolean(row.allow_order_submit),
    include_zero_stock: Boolean(row.include_zero_stock),
    expose_unit_cost: Boolean(row.expose_unit_cost),
    notes: normalizeText(row.notes),
    expires_at: normalizeText(row.expires_at),
    api_key_prefix: normalizeText(row.api_key_prefix),
    last_used_at: normalizeText(row.last_used_at),
    last_used_ip: normalizeText(row.last_used_ip),
    warehouse_ids: warehouseIds,
    warehouse_labels: warehouseIds.map((warehouseId) => {
      const warehouse = warehouseMap.get(warehouseId);
      const code = normalizeText(warehouse?.warehouse_code);
      const name = normalizeText(warehouse?.warehouse_name);
      return [code, name].filter(Boolean).join(" · ") || warehouseId;
    }),
    created_at: normalizeText(row.created_at),
    updated_at: normalizeText(row.updated_at),
  };
}

async function fetchWarehouseMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  warehouseIds: string[] = [],
) {
  const params: Record<string, string> = {
    select: "id,warehouse_code,warehouse_name,fulfillment_model,is_active",
    organization_id: `eq.${organizationId}`,
    order: "warehouse_name.asc",
  };
  if (warehouseIds.length) {
    params.id = buildInFilter(warehouseIds);
  }
  const rows = await getJson<WarehouseRow[]>(buildRestUrl(supabaseUrl, "warehouses", params), {
    headers: serviceRoleHeaders(serviceRoleKey),
  });
  return new Map(rows.map((row) => [normalizeText(row.id), row]));
}

async function fetchClientList(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
) {
  const clients = await getJson<WarehouseApiClientRow[]>(
      buildRestUrl(supabaseUrl, "warehouse_api_clients", {
          select: "id,organization_id,client_name,partner_name,status,api_key_prefix,allowed_ip_list,require_hmac,allow_order_submit,include_zero_stock,expose_unit_cost,notes,expires_at,last_used_at,last_used_ip,created_at,updated_at",
      organization_id: `eq.${organizationId}`,
      order: "partner_name.asc,client_name.asc",
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );

  const clientIds = clients.map((row) => normalizeText(row.id)).filter(Boolean);
  if (!clientIds.length) return [];

  const links = await getJson<WarehouseApiClientWarehouseRow[]>(
    buildRestUrl(supabaseUrl, "warehouse_api_client_warehouses", {
      select: "client_id,warehouse_id",
      organization_id: `eq.${organizationId}`,
      client_id: buildInFilter(clientIds),
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );

  const warehouseIds = uniqueIds(links.map((row) => row.warehouse_id));
  const warehouseMap = await fetchWarehouseMap(supabaseUrl, serviceRoleKey, organizationId, warehouseIds);
  const linkMap = new Map<string, string[]>();
  links.forEach((row) => {
    const clientId = normalizeText(row.client_id);
    const warehouseId = normalizeText(row.warehouse_id);
    if (!clientId || !warehouseId) return;
    const current = linkMap.get(clientId) || [];
    current.push(warehouseId);
    linkMap.set(clientId, current);
  });

  return clients.map((row) => mapClientRow(row, linkMap, warehouseMap));
}

async function replaceClientWarehouses(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  clientId: string,
  warehouseIds: string[],
) {
  await sendJson<unknown>(
    buildRestUrl(supabaseUrl, "warehouse_api_client_warehouses", {
      organization_id: `eq.${organizationId}`,
      client_id: `eq.${clientId}`,
    }),
    {
      method: "DELETE",
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );

  if (!warehouseIds.length) return;

  const payload = warehouseIds.map((warehouseId) => ({
    organization_id: organizationId,
    client_id: clientId,
    warehouse_id: warehouseId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));

  await sendJson<unknown>(`${supabaseUrl}/rest/v1/warehouse_api_client_warehouses`, {
    method: "POST",
    headers: {
      ...serviceRoleHeaders(serviceRoleKey),
      Prefer: "return=minimal",
    },
    body: JSON.stringify(payload),
  });
}

export default async (req: Request, _context: Context) => {
  try {
    const caller = await requireCallerProfile(req, ["superadmin", "admin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const apiBaseUrl = `${new URL(req.url).origin}/api/warehouse-stock-feed`;
    if (req.method === "GET") {
      const clients = await fetchClientList(caller.supabaseUrl, caller.serviceRoleKey, caller.profile.organization_id);
      return json({
        ok: true,
        clients,
        apiBaseUrl,
        headerName: "x-api-key",
      });
    }

    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const payload = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = normalizeText(payload.action || "save").toLowerCase();
    const organizationId = caller.profile.organization_id;

    if (action === "delete") {
      const clientId = normalizeText(payload.id);
      if (!isUuid(clientId)) return json({ error: "Client id is required" }, 400);
      await sendJson<unknown>(
        buildRestUrl(caller.supabaseUrl, "warehouse_api_clients", {
          organization_id: `eq.${organizationId}`,
          id: `eq.${clientId}`,
        }),
        {
          method: "DELETE",
          headers: serviceRoleHeaders(caller.serviceRoleKey),
        },
      );
      return json({ ok: true });
    }

    if (action === "rotate") {
      const clientId = normalizeText(payload.id);
      if (!isUuid(clientId)) return json({ error: "Client id is required" }, 400);

      const existing = await getJson<WarehouseApiClientRow[]>(
        buildRestUrl(caller.supabaseUrl, "warehouse_api_clients", {
          select: "id",
          organization_id: `eq.${organizationId}`,
          id: `eq.${clientId}`,
          limit: "1",
        }),
        {
          headers: serviceRoleHeaders(caller.serviceRoleKey),
        },
      );
      if (!existing[0]?.id) return json({ error: "Client not found" }, 404);

      const apiKey = buildApiKey();
      const apiKeyHash = await hashPortalToken(apiKey);
      await sendJson<WarehouseApiClientRow[]>(
        buildRestUrl(caller.supabaseUrl, "warehouse_api_clients", {
          select: "id",
          organization_id: `eq.${organizationId}`,
          id: `eq.${clientId}`,
        }),
        {
          method: "PATCH",
          headers: {
            ...serviceRoleHeaders(caller.serviceRoleKey),
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            api_key_hash: apiKeyHash,
            api_key_prefix: buildPrefix(apiKey),
            updated_at: new Date().toISOString(),
          }),
        },
      );

      const clients = await fetchClientList(caller.supabaseUrl, caller.serviceRoleKey, organizationId);
      return json({
        ok: true,
        client: clients.find((row) => row.id === clientId) || null,
        secret: {
          api_key: apiKey,
          api_base_url: apiBaseUrl,
          header_name: "x-api-key",
          sample_url: `${apiBaseUrl}?warehouse_code=WH-01&brand=Bosch`,
        },
      });
    }

    if (action !== "save") return json({ error: "Unsupported action" }, 400);

    const clientId = normalizeText(payload.id);
    const clientName = normalizeText(payload.client_name);
    const partnerName = normalizeText(payload.partner_name);
    const notes = normalizeText(payload.notes);
    const status = normalizeStatus(payload.status);
    const expiresAt = normalizeText(payload.expires_at);
    const warehouseIds = uniqueIds(Array.isArray(payload.warehouse_ids) ? payload.warehouse_ids : []);
    const includeZeroStock = payload.include_zero_stock === true;
    const exposeUnitCost = payload.expose_unit_cost === true;
    const requireHmac = payload.require_hmac !== false;
    const allowOrderSubmit = payload.allow_order_submit === true;
    const allowedIpList = normalizeText(payload.allowed_ip_list);

    if (!clientName) return json({ error: "Client name is required" }, 400);
    if (!partnerName) return json({ error: "Partner name is required" }, 400);
    if (!warehouseIds.length) return json({ error: "Select at least one stocked warehouse" }, 400);

    const warehouseMap = await fetchWarehouseMap(caller.supabaseUrl, caller.serviceRoleKey, organizationId, warehouseIds);
    const invalidWarehouseId = warehouseIds.find((warehouseId) => {
      const warehouse = warehouseMap.get(warehouseId);
      return !warehouse?.id || warehouse.is_active === false || normalizeText(warehouse.fulfillment_model) === "dropship";
    });
    if (invalidWarehouseId) {
      return json({ error: "Only active stocked warehouses can be exposed through partner API" }, 400);
    }

    let secret: {
      api_key: string;
      api_base_url: string;
      header_name: string;
      sample_url: string;
    } | null = null;
    let nextClientId = clientId;

    if (nextClientId) {
      if (!isUuid(nextClientId)) return json({ error: "Client id is invalid" }, 400);
      const existing = await getJson<WarehouseApiClientRow[]>(
        buildRestUrl(caller.supabaseUrl, "warehouse_api_clients", {
          select: "id",
          organization_id: `eq.${organizationId}`,
          id: `eq.${nextClientId}`,
          limit: "1",
        }),
        {
          headers: serviceRoleHeaders(caller.serviceRoleKey),
        },
      );
      if (!existing[0]?.id) return json({ error: "Client not found" }, 404);

      await sendJson<WarehouseApiClientRow[]>(
        buildRestUrl(caller.supabaseUrl, "warehouse_api_clients", {
          select: "id",
          organization_id: `eq.${organizationId}`,
          id: `eq.${nextClientId}`,
        }),
        {
          method: "PATCH",
          headers: {
            ...serviceRoleHeaders(caller.serviceRoleKey),
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            client_name: clientName,
            partner_name: partnerName,
            status,
            allowed_ip_list: allowedIpList,
            require_hmac: requireHmac,
            allow_order_submit: allowOrderSubmit,
            include_zero_stock: includeZeroStock,
            expose_unit_cost: exposeUnitCost,
            notes,
            expires_at: expiresAt || null,
            updated_at: new Date().toISOString(),
          }),
        },
      );
    } else {
      const apiKey = buildApiKey();
      const apiKeyHash = await hashPortalToken(apiKey);
      const rows = await sendJson<WarehouseApiClientRow[]>(
        `${caller.supabaseUrl}/rest/v1/warehouse_api_clients`,
        {
          method: "POST",
          headers: {
            ...serviceRoleHeaders(caller.serviceRoleKey),
            Prefer: "return=representation",
          },
          body: JSON.stringify({
            organization_id: organizationId,
            client_name: clientName,
            partner_name: partnerName,
            status,
            allowed_ip_list: allowedIpList,
            require_hmac: requireHmac,
            allow_order_submit: allowOrderSubmit,
            api_key_hash: apiKeyHash,
            api_key_prefix: buildPrefix(apiKey),
            include_zero_stock: includeZeroStock,
            expose_unit_cost: exposeUnitCost,
            notes,
            expires_at: expiresAt || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        },
      );
      nextClientId = normalizeText(rows[0]?.id);
      secret = {
        api_key: apiKey,
        api_base_url: apiBaseUrl,
        header_name: "x-api-key",
        sample_url: `${apiBaseUrl}?warehouse_code=WH-01&brand=Bosch`,
      };
    }

    await replaceClientWarehouses(caller.supabaseUrl, caller.serviceRoleKey, organizationId, nextClientId, warehouseIds);
    const clients = await fetchClientList(caller.supabaseUrl, caller.serviceRoleKey, organizationId);
    return json({
      ok: true,
      client: clients.find((row) => row.id === nextClientId) || null,
      secret,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Warehouse API client request failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-warehouse-stock-clients",
};
