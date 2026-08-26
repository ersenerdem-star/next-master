import { buildRestUrl, getJson, serviceRoleHeaders } from "./http.mts";
import { normalizeLifecycleStatus, sanitizeCatalogOemNumbers } from "./catalog-standardization.mts";
import { createPortalSessionToken, hashPortalToken, verifyPortalSessionToken } from "./portal-security.mts";
import { assertPortalTenantInvite, isLocalPortalHostname, resolvePortalSellerTenant, type PortalSellerTenant } from "./portal-tenant.mts";

export type PortalInviteRow = {
  id: string;
  organization_id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  customer_id: string | null;
  vendor_id: string | null;
  seller_company_profile_id?: string | null;
  email: string;
  contact_name: string;
  status: "draft" | "invited" | "active" | "disabled";
  invite_token_hash: string | null;
  last_sent_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  access_can_view_account: boolean;
  access_can_view_invoices: boolean;
  access_can_view_payments: boolean;
  access_can_view_orders: boolean;
  allowed_brand_ids?: string[] | null;
  updated_at: string | null;
};

const PORTAL_INVITE_SELECT =
  "id,organization_id,party_type,party_name,customer_id,vendor_id,seller_company_profile_id,email,contact_name,status,invite_token_hash,last_sent_at,expires_at,last_used_at,access_can_view_account,access_can_view_invoices,access_can_view_payments,access_can_view_orders,allowed_brand_ids,updated_at";
const PORTAL_INVITE_SELECT_ACCESS =
  "id,organization_id,party_type,party_name,customer_id,vendor_id,seller_company_profile_id,email,contact_name,status,invite_token_hash,last_sent_at,expires_at,last_used_at,access_can_view_account,access_can_view_invoices,access_can_view_payments,access_can_view_orders,updated_at";
const PORTAL_INVITE_SELECT_LEGACY =
  "id,organization_id,party_type,party_name,customer_id,vendor_id,email,contact_name,status,invite_token_hash,last_sent_at,expires_at,last_used_at,updated_at";

const CUSTOMER_PORTAL_SELECT =
  "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,remarks,custom_fields,seller_company_profile_id,price_list_type,portal_c_price_mode";
const CUSTOMER_PORTAL_SELECT_LEGACY =
  "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,remarks,custom_fields,price_list_type";
const CUSTOMER_PORTAL_SELECT_BASE =
  "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,remarks,custom_fields";
const CUSTOMER_META_PREFIX = "[[NEXT_MASTER_META]]";
const COMPANY_PROFILE_SELECT = "id,company_name,email,phone,website,address,bank_details,tax_office,tax_number,footer_note,logo_data_url";
const PORTAL_DB_REQUEST_TIMEOUT_MS = 12_000;
// Portal home is an operational workspace, not a full historical export.
// Keeping secondary document queries bounded prevents a large customer or
// vendor history from delaying sign-in and the initial portal snapshot.
const PORTAL_SNAPSHOT_HISTORY_LIMIT = "100";

function toPortalBrandingProfile(companyProfile: Record<string, unknown> | null) {
  if (!companyProfile) return null;
  return {
    company_name: String(companyProfile.company_name || "").trim() || "",
    logo_data_url: String(companyProfile.logo_data_url || "").trim() || "",
  };
}

function toCustomerCompanyProfile(companyProfile: Record<string, unknown> | null) {
  if (!companyProfile) return null;
  return {
    id: String(companyProfile.id || ""),
    company_name: String(companyProfile.company_name || ""),
    email: String(companyProfile.email || ""),
    phone: String(companyProfile.phone || ""),
    website: String(companyProfile.website || ""),
    address: String(companyProfile.address || ""),
    footer_note: String(companyProfile.footer_note || ""),
    logo_data_url: String(companyProfile.logo_data_url || ""),
  };
}

function hasPortalInviteExpired(invite: PortalInviteRow | null | undefined) {
  const expiresAt = String(invite?.expires_at || "").trim();
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp <= Date.now();
}

function isPortalInviteUsable(invite: PortalInviteRow | null | undefined) {
  if (!invite) return false;
  const status = String(invite.status || "").trim().toLowerCase();
  if (status === "active") return true;
  if (status !== "invited") return false;
  if (hasPortalInviteExpired(invite)) return false;
  return true;
}

function isPortalInvitePasswordReady(invite: PortalInviteRow | null | undefined) {
  if (!invite) return false;
  const status = String(invite.status || "").trim().toLowerCase();
  if (status === "disabled") return false;
  if (!String(invite.invite_token_hash || "").trim()) return false;
  return status === "active";
}

function requirePortalCustomerScope(invite: PortalInviteRow) {
  if (invite.party_type !== "customer") {
    throw new Error("Portal invite is not scoped to a customer.");
  }
  const customerId = String(invite.customer_id || "").trim();
  if (!customerId) {
    throw new Error("Portal invite is missing its customer scope.");
  }
  return customerId;
}

function portalAllowedBrandIds(invite: PortalInviteRow) {
  return [...new Set((Array.isArray(invite.allowed_brand_ids) ? invite.allowed_brand_ids : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

async function fetchFirst<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  const rows = await getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
    timeoutMs: PORTAL_DB_REQUEST_TIMEOUT_MS,
  });
  return rows[0] || null;
}

async function fetchAll<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  return getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
    timeoutMs: PORTAL_DB_REQUEST_TIMEOUT_MS,
  });
}

function normalizePortalInviteRow(row: PortalInviteRow | null | undefined) {
  if (!row) return null;
  return {
    ...row,
    access_can_view_account: row.access_can_view_account ?? true,
    access_can_view_invoices: row.access_can_view_invoices ?? true,
    access_can_view_payments: row.access_can_view_payments ?? true,
    access_can_view_orders: row.access_can_view_orders ?? true,
    allowed_brand_ids: Array.isArray(row.allowed_brand_ids) ? row.allowed_brand_ids : [],
  } satisfies PortalInviteRow;
}

async function fetchPortalInvitesByEmail(supabaseUrl: string, serviceRoleKey: string, email: string, organizationId = "", sellerCompanyProfileId = "") {
  const params = {
    email: `ilike.${String(email || "").trim().toLowerCase()}`,
    ...(String(organizationId || "").trim() ? { organization_id: `eq.${String(organizationId).trim()}` } : {}),
    ...(String(sellerCompanyProfileId || "").trim() ? { seller_company_profile_id: `eq.${String(sellerCompanyProfileId).trim()}` } : {}),
    order: "updated_at.desc",
    limit: "20",
  };
  try {
    const rows = await fetchAll<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
      select: PORTAL_INVITE_SELECT,
      ...params,
    });
    return rows.map((row) => normalizePortalInviteRow(row)).filter(Boolean) as PortalInviteRow[];
  } catch (primaryError) {
    try {
      const rows = await fetchAll<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
        select: PORTAL_INVITE_SELECT_ACCESS,
        ...params,
      });
      return rows.map((row) => normalizePortalInviteRow(row)).filter(Boolean) as PortalInviteRow[];
    } catch (accessError) {
      try {
        const rows = await fetchAll<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
          select: PORTAL_INVITE_SELECT_LEGACY,
          ...params,
        });
        return rows.map((row) => normalizePortalInviteRow(row)).filter(Boolean) as PortalInviteRow[];
      } catch (legacyError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError || "");
        const accessMessage = accessError instanceof Error ? accessError.message : String(accessError || "");
        const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError || "");
        throw new Error(legacyMessage || accessMessage || primaryMessage || "Portal invite lookup failed");
      }
    }
  }
}

async function fetchPortalInviteByIdEmail(supabaseUrl: string, serviceRoleKey: string, inviteId: string, email: string, organizationId = "", sellerCompanyProfileId = "") {
  const rows = await fetchPortalInvitesByEmail(supabaseUrl, serviceRoleKey, email, organizationId, sellerCompanyProfileId);
  const normalizedInviteId = String(inviteId || "").trim();
  return rows.find((row) => String(row.id || "").trim() === normalizedInviteId) || null;
}

function isPortalSoftFailure(error: unknown) {
  const details = error as { message?: unknown; rawMessage?: unknown; status?: unknown };
  const message = String(details?.rawMessage || details?.message || error || "").toLowerCase();
  const status = Number(details?.status || 0);
  return (
    status === 404 ||
    message.includes("could not find the table") ||
    message.includes("relation") && message.includes("does not exist") ||
    message.includes("column") && message.includes("does not exist") ||
    message.includes("schema cache") ||
    message.includes("failed to parse") ||
    message.includes("statement timeout") ||
    message.includes("canceling statement due to statement timeout") ||
    message.includes("timed out") ||
    message.includes("took too long")
  );
}

async function fetchAllOptional<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  try {
    return await fetchAll<T>(supabaseUrl, serviceRoleKey, table, params);
  } catch (error) {
    if (isPortalSoftFailure(error)) {
      return [];
    }
    throw error;
  }
}

function buildPortalCustomerHistoryParams(
  organizationId: string,
  customerId: string,
  customerName: string,
  sellerCompanyName: string,
) {
  const normalizedCustomerId = String(customerId || "").trim();
  const normalizedCustomerName = String(customerName || "").trim();
  const customerFilter = normalizedCustomerId && normalizedCustomerName
    ? { or: `(customer_id.eq.${normalizedCustomerId},customer_name.eq.${normalizedCustomerName})` }
    : normalizedCustomerId
      ? { customer_id: `eq.${normalizedCustomerId}` }
      : normalizedCustomerName
        ? { customer_name: `eq.${normalizedCustomerName}` }
        : {};

  return {
    organization_id: `eq.${organizationId}`,
    ...customerFilter,
    ...(sellerCompanyName ? { seller_company: `eq.${sellerCompanyName}` } : {}),
    order: "updated_at.desc",
    limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
  };
}

async function fetchPortalHistoryRows(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: "sales_orders" | "invoices",
  fullSelect: string,
  compactSelect: string,
  params: Record<string, string>,
) {
  // History cards only need the compact document fields. Fetching the large
  // JSON `lines` column first made this endpoint time out while catalog
  // enrichment was running, and the soft-failure path then looked like an
  // empty customer history. Keep the list fast and deterministic by loading
  // compact rows first. Detail lines can be loaded by the existing document
  // detail flow when the user opens a record.
  const compactRows = await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, table, {
    select: compactSelect,
    ...params,
  });
  const attachDetailLines = async (rows: Record<string, unknown>[]) => {
    if (!rows.length || !fullSelect) return rows;
    const ids = rows
      .map((row) => String(row.id || "").trim())
      .filter(Boolean);
    if (!ids.length) return rows;

    // Keep the history/list query compact, then load the bounded line detail
    // for the same tenant/customer-scoped document ids. This preserves fast
    // portal startup while ensuring the Orders/Invoices detail view has the
    // same line data as the admin Sales Order screen.
    // The compact query already established the tenant/customer scope. Keep
    // this follow-up intentionally narrow so optional legacy columns in the
    // full document projection cannot make line details disappear entirely.
    const detailRows = await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, table, {
      select: "id,lines",
      organization_id: params.organization_id,
      id: `in.(${ids.join(",")})`,
      limit: String(ids.length),
    });
    // A minority of PostgREST deployments reject an `in.(...)` predicate for
    // opaque portal order ids. Fall back to small, tenant-scoped id lookups
    // only when that batched projection returned no rows: an existing order
    // must never render as a document with no lines because a read fallback
    // happened to be unavailable.
    const resolvedDetailRows = detailRows.length
      ? detailRows
      : (
          await Promise.all(
            ids.map((id) =>
              fetchFirstOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, table, {
                select: "id,lines",
                organization_id: params.organization_id,
                id: `eq.${id}`,
                limit: "1",
              }),
            ),
          )
        ).filter((row): row is Record<string, unknown> => Boolean(row));
    if (!resolvedDetailRows.length) return rows;
    const byId = new Map(resolvedDetailRows.map((row) => [String(row.id || ""), row]));
    return rows.map((row) => byId.get(String(row.id || "")) || row);
  };

  if (compactRows.length) return attachDetailLines(compactRows);

  // If the combined OR filter was the expensive part under load, retry the
  // same tenant-scoped request as two simple indexed lookups and deduplicate
  // by document id. This still never broadens the customer/seller scope.
  const customerFilter = params.or;
  if (!customerFilter) return compactRows;
  const match = customerFilter.match(/^\(customer_id\.eq\.([^,]+),customer_name\.eq\.(.*)\)$/);
  if (!match) return compactRows;
  const [, customerId, customerName] = match;
  const { or: _or, ...baseParams } = params;
  const [byId, byName] = await Promise.all([
    fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, table, {
      select: compactSelect,
      ...baseParams,
      customer_id: `eq.${customerId}`,
    }),
    fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, table, {
      select: compactSelect,
      ...baseParams,
      customer_name: `eq.${customerName}`,
    }),
  ]);
  return attachDetailLines(dedupeById([...byId, ...byName]));
}

async function fetchFirstOptional<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  try {
    return await fetchFirst<T>(supabaseUrl, serviceRoleKey, table, params);
  } catch (error) {
    if (isPortalSoftFailure(error)) {
      return null;
    }
    throw error;
  }
}

async function fetchPortalCustomerRecord(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  invite: PortalInviteRow,
) {
  const customerId = requirePortalCustomerScope(invite);
  const trySelect = async (select: string) =>
    await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customers", {
      select,
      organization_id: `eq.${organizationId}`,
      id: `eq.${customerId}`,
      ...(String(invite.seller_company_profile_id || "").trim()
        ? { seller_company_profile_id: `eq.${String(invite.seller_company_profile_id).trim()}` }
        : {}),
      limit: "1",
    });

  try {
    return await trySelect(CUSTOMER_PORTAL_SELECT);
  } catch (primaryError) {
    try {
      return await trySelect(CUSTOMER_PORTAL_SELECT_LEGACY);
    } catch (legacyError) {
      try {
        return await trySelect(CUSTOMER_PORTAL_SELECT_BASE);
      } catch (baseError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError || "");
        const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError || "");
        const baseMessage = baseError instanceof Error ? baseError.message : String(baseError || "");
        throw new Error(baseMessage || legacyMessage || primaryMessage || "Customer portal record lookup failed");
      }
    }
  }
}

async function touchPortalInvite(supabaseUrl: string, serviceRoleKey: string, invite: PortalInviteRow) {
  await fetch(buildRestUrl(supabaseUrl, "portal_invites", { id: `eq.${invite.id}` }), {
    method: "PATCH",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify({
      status: "active",
      expires_at: null,
      last_used_at: new Date().toISOString(),
    }),
  });
}

function dedupeById<T extends { id?: string | null }>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = String(row.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function toNumber(value: unknown) {
  return Number(value ?? 0) || 0;
}

function buildDiscontinuedWarning(resolvedCode: string, note?: string | null) {
  const code = String(resolvedCode || "").trim();
  const base = code ? `Production ended for ${code}.` : "Production ended for this item.";
  const detail = String(note || "").trim();
  return detail ? `${base} ${detail}` : base;
}

function parseEmbeddedCustomerMeta(raw: unknown) {
  const text = String(raw || "");
  const markerIndex = text.lastIndexOf(CUSTOMER_META_PREFIX);
  if (markerIndex < 0) return {} as Record<string, unknown>;
  const jsonText = text.slice(markerIndex + CUSTOMER_META_PREFIX.length).trim();
  try {
    return (JSON.parse(jsonText) as Record<string, unknown>) || {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

function getEmbeddedCustomerPriceListType(meta: Record<string, unknown>) {
  const value = String(meta.price_list_type || "").trim();
  if (value === "A" || value === "B" || value === "C" || value === "Other") return value;
  return "";
}

function readCustomerPortalMetadata(customer: Record<string, unknown> | null) {
  const customerMeta = parseEmbeddedCustomerMeta(customer?.custom_fields);
  const sellerCompanyProfileId = String(customer?.seller_company_profile_id || customerMeta.seller_company_profile_id || "").trim();
  const portalCPriceMode =
    String(customer?.portal_c_price_mode || customerMeta.portal_c_price_mode || "standard").trim().toLowerCase() ===
    "prefer_c_when_available"
      ? "prefer_c_when_available"
      : "standard";
  return {
    customerMeta,
    sellerCompanyProfileId,
    portalCPriceMode,
  } as const;
}

async function fetchPortalCompanyProfile(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  sellerCompanyProfileId = "",
) {
  return (
    (sellerCompanyProfileId
      ? await fetchFirstOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "company_profiles", {
          select: COMPANY_PROFILE_SELECT,
          organization_id: `eq.${organizationId}`,
          id: `eq.${sellerCompanyProfileId}`,
          limit: "1",
        })
      : null) ||
    (await fetchFirstOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "company_profiles", {
      select: COMPANY_PROFILE_SELECT,
      organization_id: `eq.${organizationId}`,
      order: "updated_at.desc",
      limit: "1",
    }))
  );
}

function normalizeBrandNameList(values: string[]) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function extractRelatedBrandName(row: Record<string, unknown>) {
  const related = row.brands as { name?: string | null } | Array<{ name?: string | null }> | null | undefined;
  if (Array.isArray(related)) return String(related[0]?.name || "").trim();
  return String(related?.name || "").trim();
}

async function fetchPortalAvailableBrands(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  enabled: boolean,
  allowedBrandIds: string[] = [],
) {
  if (!enabled) return [];
  const allowedSet = new Set(allowedBrandIds.filter(Boolean));
  const directParams: Record<string, string> = {
    select: "name",
    organization_id: `eq.${organizationId}`,
    order: "name.asc",
  };
  if (allowedSet.size) {
    directParams.id = `in.(${[...allowedSet].join(",")})`;
  }
  const direct = normalizeBrandNameList(
    (
      await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "brands", {
        ...directParams,
      })
    ).map((row) => String(row.name || "")),
  );
  if (direct.length) return direct;

  const fallbackParams: Record<string, string> = {
    select: "brand_id,brands(name)",
    organization_id: `eq.${organizationId}`,
    order: "brand_id.asc",
    limit: "5000",
  };
  if (allowedSet.size) {
    fallbackParams.brand_id = `in.(${[...allowedSet].join(",")})`;
  }
  const fallback = normalizeBrandNameList(
    (
      await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
        ...fallbackParams,
      })
    ).map((row) => extractRelatedBrandName(row)),
  );
  return fallback;
}

function normalizeStoredLines(lines: unknown) {
  if (typeof lines !== "string") return lines;
  try {
    return JSON.parse(lines);
  } catch {
    return [];
  }
}

function mapSalesOrderLines(lines: unknown) {
  const normalizedLines = normalizeStoredLines(lines);
  if (!Array.isArray(normalizedLines)) return [];
  return normalizedLines.map((line) => {
    const row = (line || {}) as Record<string, unknown>;
    const qty = toNumber(row.qty);
    const sellPrice = row.sell_price == null ? null : toNumber(row.sell_price);
    const purchaseTotal = row.buy_price == null ? null : toNumber(row.buy_price) * qty;
    const salesTotal = sellPrice == null ? null : sellPrice * qty;
    const lifecycleStatus = normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`);
    const lifecycleNote = String(row.lifecycle_note || "").trim() || null;
    // Portal-created lines use resolvedCode/requestedCode; admin-created
    // sales orders use the canonical product_code/old_code shape. Normalize
    // both representations so customer order detail and exports never lose
    // their line identity when an order originated on the admin side.
    const resolvedCode = String(row.resolvedCode || row.requestedCode || row.product_code || row.code || "");
    return {
      code: resolvedCode,
      requested_code: String(row.requestedCode || row.old_code || row.product_code || row.code || ""),
      brand: String(row.brand || ""),
      description: String(row.description || ""),
      qty,
      oem_no: sanitizeCatalogOemNumbers(row.oem_no),
      hs_code: String(row.hs_code || ""),
      origin: String(row.origin || ""),
      weight_kg: row.weight_kg == null ? null : toNumber(row.weight_kg),
      supplier_name: String(row.supplier_name || ""),
      buy_price: row.buy_price == null ? null : toNumber(row.buy_price),
      sell_price: sellPrice,
      purchase_total: purchaseTotal,
      sales_total: salesTotal,
      line_total: salesTotal,
      price_date: String(row.price_date || ""),
      notes: String(row.notes || ""),
      lifecycle_status: lifecycleStatus,
      lifecycle_note: lifecycleNote,
      lifecycle_warning:
        lifecycleStatus === "discontinued"
          ? String(row.lifecycle_warning || "").trim() || buildDiscontinuedWarning(resolvedCode, lifecycleNote)
          : null,
    };
  });
}

function mapInvoiceLines(lines: unknown) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const row = (line || {}) as Record<string, unknown>;
    const lifecycleStatus = normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`);
    const lifecycleNote = String(row.lifecycle_note || "").trim() || null;
    const resolvedCode = String(row.product_code || "");
    return {
      code: resolvedCode,
      old_code: String(row.old_code || ""),
      brand: String(row.brand || ""),
      description: String(row.description || ""),
      qty: toNumber(row.qty),
      oem_no: sanitizeCatalogOemNumbers(row.oem_no),
      hs_code: String(row.hs_code || ""),
      origin: String(row.origin || ""),
      weight_kg: row.weight_kg == null ? null : toNumber(row.weight_kg),
      supplier_name: String(row.supplier_name || ""),
      buy_price: row.buy_price == null ? null : toNumber(row.buy_price),
      sell_price: row.sell_price == null ? null : toNumber(row.sell_price),
      purchase_total: row.purchase_total == null ? null : toNumber(row.purchase_total),
      sales_total: row.sales_total == null ? null : toNumber(row.sales_total),
      line_total: row.sales_total == null ? null : toNumber(row.sales_total),
      notes: String(row.notes || ""),
      lifecycle_status: lifecycleStatus,
      lifecycle_note: lifecycleNote,
      lifecycle_warning:
        lifecycleStatus === "discontinued"
          ? String(row.lifecycle_warning || "").trim() || buildDiscontinuedWarning(resolvedCode, lifecycleNote)
          : null,
    };
  });
}

// Customer responses must not expose internal supplier or acquisition-cost data.
function mapCustomerSalesOrderLines(lines: unknown) {
  return mapSalesOrderLines(lines).map(({ supplier_name: _supplierName, buy_price: _buyPrice, purchase_total: _purchaseTotal, ...line }) => line);
}

function mapCustomerInvoiceLines(lines: unknown) {
  return mapInvoiceLines(lines).map(({ supplier_name: _supplierName, buy_price: _buyPrice, purchase_total: _purchaseTotal, ...line }) => line);
}

function mapPurchaseOrderLines(lines: unknown) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const row = (line || {}) as Record<string, unknown>;
    return {
      code: String(row.product_code || ""),
      old_code: String(row.old_code || ""),
      brand: String(row.brand || ""),
      description: String(row.description || ""),
      qty: toNumber(row.qty),
      oem_no: sanitizeCatalogOemNumbers(row.oem_no),
      origin: String(row.origin || ""),
      supplier_name: String(row.supplier_name || ""),
      buy_price: row.buy_price == null ? null : toNumber(row.buy_price),
      line_total: row.line_total == null ? null : toNumber(row.line_total),
      notes: String(row.notes || ""),
    };
  });
}

async function fetchPortalInviteByEmailPreview(supabaseUrl: string, serviceRoleKey: string, email: string, organizationId = "", sellerCompanyProfileId = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;
  const invites = await fetchPortalInvitesByEmail(supabaseUrl, serviceRoleKey, normalizedEmail, organizationId, sellerCompanyProfileId);
  return invites.find((invite) => isPortalInviteUsable(invite)) || invites.find((invite) => isPortalInvitePasswordReady(invite)) || null;
}

export async function fetchPortalInviteByEmail(supabaseUrl: string, serviceRoleKey: string, email: string, organizationId = "", sellerCompanyProfileId = "") {
  return fetchPortalInviteByEmailPreview(supabaseUrl, serviceRoleKey, email, organizationId, sellerCompanyProfileId);
}

export async function fetchPortalInviteByIdAndEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  inviteId: string,
  email: string,
  organizationId = "",
  sellerCompanyProfileId = "",
) {
  return fetchPortalInviteByIdEmail(supabaseUrl, serviceRoleKey, inviteId, email, organizationId, sellerCompanyProfileId);
}

export async function validatePortalInvite(supabaseUrl: string, serviceRoleKey: string, email: string, password: string, organizationId = "", sellerCompanyProfileId = "") {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const tokenHash = await hashPortalToken(password);
  let invite: PortalInviteRow | null = null;
  let fallbackInvites: PortalInviteRow[] = [];

  try {
    fallbackInvites = await fetchPortalInvitesByEmail(supabaseUrl, serviceRoleKey, normalizedEmail, organizationId, sellerCompanyProfileId);
    invite =
      fallbackInvites.find(
        (row) =>
          isPortalInviteUsable(row) && String(row.invite_token_hash || "").trim().toLowerCase() === tokenHash,
      ) ||
      fallbackInvites.find(
        (row) =>
          isPortalInvitePasswordReady(row) && String(row.invite_token_hash || "").trim().toLowerCase() === tokenHash,
      ) ||
      null;
  } catch {
    fallbackInvites = [];
    invite = null;
  }

  if (!isPortalInvitePasswordReady(invite)) {
    const hasKnownInvite = fallbackInvites.some((row) => String(row.status || "").trim().toLowerCase() !== "disabled");
    if (hasKnownInvite) {
      throw new Error("Portal password is incorrect. Use Forgot password.");
    }
    throw new Error("Portal invite not found or disabled");
  }

  await touchPortalInvite(supabaseUrl, serviceRoleKey, invite);

  return invite;
}

export async function resolvePortalInvite(
  supabaseUrl: string,
  serviceRoleKey: string,
  sessionSecret: string,
  auth: {
    email?: string | null;
    password?: string | null;
    token?: string | null;
    sessionToken?: string | null;
    hostname?: string | null;
  },
) {
  const providedPassword = String(auth.password || "").trim();
  const sessionToken = String(auth.sessionToken || "").trim();
  const providedEmail = String(auth.email || "").trim().toLowerCase();
  const hostname = String(auth.hostname || "").trim().toLowerCase();
  const tenant = await resolvePortalSellerTenant(supabaseUrl, serviceRoleKey, hostname);
  if (!tenant && hostname && !isLocalPortalHostname(hostname)) {
    throw new Error("This seller portal domain is not configured.");
  }

  if (!providedPassword && sessionToken) {
    const session = await verifyPortalSessionToken(sessionSecret, sessionToken);
    if (!session) {
      throw new Error("Portal session expired. Sign in again.");
    }

    if (tenant && String(session.organization_id || "") !== String(tenant.organization_id)) {
      throw new Error("Portal session belongs to another seller domain. Sign in again.");
    }
    if (hostname && session.hostname && hostname !== String(session.hostname).trim().toLowerCase()) {
      throw new Error("Portal session belongs to another seller domain. Sign in again.");
    }
    const invite = await fetchPortalInviteByIdEmail(
      supabaseUrl,
      serviceRoleKey,
      session.invite_id,
      session.email,
      String(session.organization_id || tenant?.organization_id || ""),
      String(tenant?.seller_company_profile_id || ""),
    );

    if (!isPortalInviteUsable(invite)) {
      throw new Error("Portal session is no longer active.");
    }
    if (String(invite.updated_at || "") !== session.updated_at) {
      throw new Error("Portal session expired. Sign in again.");
    }

    assertPortalTenantInvite(invite.organization_id, invite.seller_company_profile_id, tenant);
    await touchPortalInvite(supabaseUrl, serviceRoleKey, invite);
    const nextSessionToken = await createPortalSessionToken(sessionSecret, invite.id, invite.email, invite.organization_id, hostname, String(invite.updated_at || ""));
    return { invite, sessionToken: nextSessionToken };
  }

  const email = providedEmail;
  if (!email || !providedPassword) {
    throw new Error("Email and password are required");
  }

  const invite = await validatePortalInvite(
    supabaseUrl,
    serviceRoleKey,
    email,
    providedPassword,
    tenant?.organization_id || "",
    tenant?.seller_company_profile_id || "",
  );
  assertPortalTenantInvite(invite.organization_id, invite.seller_company_profile_id, tenant);
  const nextSessionToken = await createPortalSessionToken(sessionSecret, invite.id, invite.email, invite.organization_id, hostname, String(invite.updated_at || ""));
  return { invite, sessionToken: nextSessionToken };
}

export async function resolvePortalInvitePreview(
  supabaseUrl: string,
  serviceRoleKey: string,
  sessionSecret: string,
  auth: {
    email?: string | null;
    sessionToken?: string | null;
    hostname?: string | null;
  },
) {
  const sessionToken = String(auth.sessionToken || "").trim();
  const hostname = String(auth.hostname || "").trim().toLowerCase();
  const tenant = await resolvePortalSellerTenant(supabaseUrl, serviceRoleKey, hostname);
  if (!tenant && hostname && !isLocalPortalHostname(hostname)) {
    throw new Error("This seller portal domain is not configured.");
  }
  if (sessionToken) {
    const session = await verifyPortalSessionToken(sessionSecret, sessionToken);
    if (!session) {
      throw new Error("Portal session expired. Sign in again.");
    }
    if (tenant && String(session.organization_id || "") !== String(tenant.organization_id)) {
      throw new Error("Portal session belongs to another seller domain. Sign in again.");
    }
    if (hostname && session.hostname && hostname !== String(session.hostname).trim().toLowerCase()) {
      throw new Error("Portal session belongs to another seller domain. Sign in again.");
    }
    const invite = await fetchPortalInviteByIdEmail(
      supabaseUrl,
      serviceRoleKey,
      session.invite_id,
      session.email,
      String(session.organization_id || tenant?.organization_id || ""),
      String(tenant?.seller_company_profile_id || ""),
    );
    if (!isPortalInviteUsable(invite)) {
      throw new Error("Portal session is no longer active.");
    }
    if (String(invite.updated_at || "") !== session.updated_at) {
      throw new Error("Portal session expired. Sign in again.");
    }
    assertPortalTenantInvite(invite.organization_id, invite.seller_company_profile_id, tenant);
    const nextSessionToken = await createPortalSessionToken(sessionSecret, invite.id, invite.email, invite.organization_id, hostname, String(invite.updated_at || ""));
    return { invite, sessionToken: nextSessionToken };
  }

  // Do not reveal a tenant, party, or company profile merely because an
  // attacker knows an email address. Login branding is generic until an
  // authenticated portal session is present.
  return { invite: null, sessionToken: "" };
}

export async function buildPortalSnapshot(supabaseUrl: string, serviceRoleKey: string, invite: PortalInviteRow) {
  if (invite.party_type === "customer") {
    const customer = await fetchPortalCustomerRecord(supabaseUrl, serviceRoleKey, invite.organization_id, invite);
    const { customerMeta, sellerCompanyProfileId: customerSellerCompanyProfileId, portalCPriceMode } = readCustomerPortalMetadata(customer);
    const sellerCompanyProfileId = String(invite.seller_company_profile_id || customerSellerCompanyProfileId || "").trim();
    const companyProfile = await fetchPortalCompanyProfile(supabaseUrl, serviceRoleKey, invite.organization_id, sellerCompanyProfileId);

    const customerName = String(customer?.display_name || customer?.company_name || invite.party_name);
    const customerId = String(customer?.id || invite.customer_id || "");
    // Orders and invoices are tenant-scoped by seller company as well as customer.
    // Older records may only have customer_name populated, so the seller filter
    // must be applied to both the id and name lookup paths.
    const sellerCompanyName = String(companyProfile?.company_name || "").trim();
    const historyParams = buildPortalCustomerHistoryParams(
      invite.organization_id,
      customerId,
      customerName,
      sellerCompanyName,
    );
    const salesOrderFullSelect =
      "id,sales_order_no,customer_name,quote_date,currency,status,sales_total,source_channel,portal_submitted_at,portal_seen_at,delivery_term,payment_terms,packing_details,notes,discount_amount,shipping_cost,updated_at,lines";
    const salesOrderCompactSelect =
      "id,sales_order_no,customer_name,quote_date,currency,status,sales_total,source_channel,portal_submitted_at,portal_seen_at,delivery_term,payment_terms,packing_details,notes,discount_amount,shipping_cost,updated_at";
    const invoiceFullSelect =
      "id,sales_order_no,customer_name,quote_date,currency,status,total_amount,due_date,payment_terms,delivery_term,contract_nr,packing_details,notes,subtotal,discount_amount,shipping_cost,updated_at,lines";
    const invoiceCompactSelect =
      "id,sales_order_no,customer_name,quote_date,currency,status,total_amount,due_date,payment_terms,delivery_term,contract_nr,packing_details,notes,subtotal,discount_amount,shipping_cost,updated_at";

    const salesOrders = invite.access_can_view_orders
      ? dedupeById(await fetchPortalHistoryRows(
          supabaseUrl,
          serviceRoleKey,
          "sales_orders",
          salesOrderFullSelect,
          salesOrderCompactSelect,
          historyParams,
        ))
      : [];

    const invoices = invite.access_can_view_invoices
      ? dedupeById(await fetchPortalHistoryRows(
          supabaseUrl,
          serviceRoleKey,
          "invoices",
          invoiceFullSelect,
          invoiceCompactSelect,
          historyParams,
        ))
      : [];

    const paymentsReceived = invite.access_can_view_payments
      ? dedupeById([
          ...(customerId
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_received", {
                select: "id,invoice_no,customer_name,status,received_date,method,reference_no,amount,currency,updated_at",
                organization_id: `eq.${invite.organization_id}`,
                customer_id: `eq.${customerId}`,
                order: "updated_at.desc",
                limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
              })
            : []),
          ...((!customerId || customerName)
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_received", {
                select: "id,invoice_no,customer_name,status,received_date,method,reference_no,amount,currency,updated_at",
                organization_id: `eq.${invite.organization_id}`,
                customer_name: `eq.${customerName}`,
                order: "updated_at.desc",
                limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
              })
            : []),
        ])
      : [];

    const creditNotes = invite.access_can_view_invoices
      ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "credit_notes", {
          select: "id,credit_note_no,customer_name,status,credit_date,due_date,notes,total_amount,currency,updated_at",
          organization_id: `eq.${invite.organization_id}`,
          customer_name: `eq.${customerName}`,
          order: "updated_at.desc",
          limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
        })
      : [];

    const availableBrands = await fetchPortalAvailableBrands(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      invite.access_can_view_orders,
      portalAllowedBrandIds(invite),
    );

    const accountRows = [
      ...invoices.map((row) => ({
        document_no: String(row.id || row.sales_order_no || ""),
        document_type: "Invoice",
        document_date: String(row.quote_date || ""),
        due_date: String(row.due_date || ""),
        status: String(row.status || ""),
        amount: toNumber(row.total_amount),
        currency: String(row.currency || customer?.currency || "EUR"),
        subtotal: toNumber(row.total_amount),
        discount: 0,
        shipping: 0,
        total: toNumber(row.total_amount),
      })),
      ...creditNotes.map((row) => ({
        document_no: String(row.credit_note_no || row.id || ""),
        document_type: "Credit Note",
        document_date: String(row.credit_date || ""),
        due_date: String(row.due_date || ""),
        status: String(row.status || ""),
        amount: -Math.abs(toNumber(row.total_amount)),
        currency: String(row.currency || customer?.currency || "EUR"),
        subtotal: -Math.abs(toNumber(row.total_amount)),
        discount: 0,
        shipping: 0,
        total: -Math.abs(toNumber(row.total_amount)),
      })),
      ...paymentsReceived.map((row) => ({
        document_no: String(row.id || row.invoice_no || ""),
        document_type: "Payment",
        document_date: String(row.received_date || ""),
        due_date: "",
        status: String(row.status || ""),
        amount: -Math.abs(toNumber(row.amount)),
        currency: String(row.currency || customer?.currency || "EUR"),
        subtotal: -Math.abs(toNumber(row.amount)),
        discount: 0,
        shipping: 0,
        total: -Math.abs(toNumber(row.amount)),
      })),
    ];

    const invoiceAmount = invoices.reduce((sum, row) => sum + toNumber(row.total_amount), 0);
    const creditAmount = creditNotes.reduce((sum, row) => sum + toNumber(row.total_amount), 0);
    const paymentAmount = paymentsReceived.reduce((sum, row) => sum + toNumber(row.amount), 0);

    return {
      invite: {
        id: invite.id,
        party_type: invite.party_type,
        party_name: invite.party_name,
        email: invite.email,
        contact_name: invite.contact_name,
        status: "active",
        access: {
          can_view_account: invite.access_can_view_account,
          can_view_invoices: invite.access_can_view_invoices,
          can_view_payments: invite.access_can_view_payments,
          can_view_orders: invite.access_can_view_orders,
        },
      },
      companyProfile: toCustomerCompanyProfile(companyProfile),
      customer,
      availableBrands,
      salesOrders: salesOrders.map((row) => ({
        ...row,
        source_channel: String(row.source_channel || "internal"),
        portal_submitted_at: row.portal_submitted_at ? String(row.portal_submitted_at) : null,
        portal_seen_at: row.portal_seen_at ? String(row.portal_seen_at) : null,
        sales_total: toNumber(row.sales_total),
        discount_amount: toNumber(row.discount_amount),
        shipping_cost: toNumber(row.shipping_cost),
        lines: mapCustomerSalesOrderLines(row.lines),
      })),
      invoices: invoices.map((row) => ({
        ...row,
        total_amount: toNumber(row.total_amount),
        subtotal: toNumber(row.subtotal),
        discount_amount: toNumber(row.discount_amount),
        shipping_cost: toNumber(row.shipping_cost),
        lines: mapCustomerInvoiceLines(row.lines),
      })),
      creditNotes: creditNotes.map((row) => ({
        ...row,
        total_amount: toNumber(row.total_amount),
      })),
      purchaseOrders: [],
      bills: [],
      vendorCredits: [],
      paymentsReceived,
      paymentsMade: [],
      accountSummary: {
        currency: String(customer?.currency || invoices[0]?.currency || "EUR"),
        totalDocuments: accountRows.length,
        totalAmount: accountRows.reduce((sum, row) => sum + row.amount, 0),
        documentAmount: invoiceAmount,
        creditAmount,
        paymentAmount,
        openAmount: accountRows.filter((row) => !["void"].includes(row.status.toLowerCase())).reduce((sum, row) => sum + row.amount, 0),
        paymentCount: paymentsReceived.length,
      },
      pricingProfile: customer
        ? {
            currency: String(customer.currency || invoices[0]?.currency || "EUR"),
            payment_terms: String(customer.payment_terms || ""),
            contract_nr: String(customer.contract_nr || ""),
            price_list_type: String(customer.price_list_type || getEmbeddedCustomerPriceListType(customerMeta) || "A") as "" | "A" | "B" | "C" | "Other",
            portal_c_price_mode: portalCPriceMode,
          }
        : null,
      accountRows,
    };
  }

  const vendor =
    (invite.vendor_id
      ? await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "vendors", {
          select: "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,remarks",
          organization_id: `eq.${invite.organization_id}`,
          id: `eq.${invite.vendor_id}`,
        })
      : null) ||
    (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "vendors", {
      select: "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,remarks",
      organization_id: `eq.${invite.organization_id}`,
      display_name: `eq.${invite.party_name}`,
    })) ||
    (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "vendors", {
      select: "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,remarks",
      organization_id: `eq.${invite.organization_id}`,
      company_name: `eq.${invite.party_name}`,
    }));

  const companyProfile = await fetchPortalCompanyProfile(supabaseUrl, serviceRoleKey, invite.organization_id);

  const vendorName = String(vendor?.display_name || vendor?.company_name || invite.party_name);
  const vendorId = String(vendor?.id || invite.vendor_id || "");

  const purchaseOrders = invite.access_can_view_orders
    ? dedupeById([
        ...(vendorId
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "purchase_orders", {
              select: "id,sales_order_no,supplier_name,customer_name,status,currency,total_amount,line_count,notes,updated_at,lines",
              organization_id: `eq.${invite.organization_id}`,
              vendor_id: `eq.${vendorId}`,
              order: "updated_at.desc",
              limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
            })
          : []),
        ...((!vendorId || vendorName)
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "purchase_orders", {
              select: "id,sales_order_no,supplier_name,customer_name,status,currency,total_amount,line_count,notes,updated_at,lines",
              organization_id: `eq.${invite.organization_id}`,
              supplier_name: `eq.${vendorName}`,
              order: "updated_at.desc",
              limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
            })
          : []),
      ])
    : [];

  const bills = invite.access_can_view_invoices
    ? dedupeById([
        ...(vendorId
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "bills", {
              select:
                "id,purchase_order_no,supplier_name,status,currency,total_amount,bill_date,due_date,payment_terms,notes,subtotal,discount_amount,shipping_cost,updated_at,lines",
              organization_id: `eq.${invite.organization_id}`,
              vendor_id: `eq.${vendorId}`,
              order: "updated_at.desc",
              limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
            })
          : []),
        ...((!vendorId || vendorName)
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "bills", {
              select:
                "id,purchase_order_no,supplier_name,status,currency,total_amount,bill_date,due_date,payment_terms,notes,subtotal,discount_amount,shipping_cost,updated_at,lines",
              organization_id: `eq.${invite.organization_id}`,
              supplier_name: `eq.${vendorName}`,
              order: "updated_at.desc",
              limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
            })
          : []),
      ])
    : [];

  const paymentsMade = invite.access_can_view_payments
    ? dedupeById([
        ...(vendorId
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_made", {
              select: "id,bill_no,supplier_name,status,payment_date,method,reference_no,amount,currency,updated_at",
              organization_id: `eq.${invite.organization_id}`,
              vendor_id: `eq.${vendorId}`,
              order: "updated_at.desc",
              limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
            })
          : []),
        ...((!vendorId || vendorName)
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_made", {
              select: "id,bill_no,supplier_name,status,payment_date,method,reference_no,amount,currency,updated_at",
              organization_id: `eq.${invite.organization_id}`,
              supplier_name: `eq.${vendorName}`,
              order: "updated_at.desc",
              limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
            })
          : []),
      ])
    : [];

  const vendorCredits = invite.access_can_view_invoices
    ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "vendor_credits", {
        select: "id,vendor_credit_no,supplier_name,status,credit_date,due_date,notes,total_amount,currency,updated_at",
        organization_id: `eq.${invite.organization_id}`,
        supplier_name: `eq.${vendorName}`,
        order: "updated_at.desc",
        limit: PORTAL_SNAPSHOT_HISTORY_LIMIT,
      })
    : [];

  const accountRows = [
    ...bills.map((row) => ({
      document_no: String(row.id || row.purchase_order_no || ""),
      document_type: "Bill",
      document_date: String(row.bill_date || ""),
      due_date: String(row.due_date || ""),
      status: String(row.status || ""),
      amount: toNumber(row.total_amount),
      currency: String(row.currency || vendor?.currency || "EUR"),
      subtotal: toNumber(row.subtotal ?? row.total_amount),
      discount: toNumber(row.discount_amount),
      shipping: toNumber(row.shipping_cost),
      total: toNumber(row.total_amount),
    })),
    ...vendorCredits.map((row) => ({
      document_no: String(row.vendor_credit_no || row.id || ""),
      document_type: "Vendor Credit",
      document_date: String(row.credit_date || ""),
      due_date: String(row.due_date || ""),
      status: String(row.status || ""),
      amount: -Math.abs(toNumber(row.total_amount)),
      currency: String(row.currency || vendor?.currency || "EUR"),
      subtotal: -Math.abs(toNumber(row.total_amount)),
      discount: 0,
      shipping: 0,
      total: -Math.abs(toNumber(row.total_amount)),
    })),
    ...paymentsMade.map((row) => ({
      document_no: String(row.id || row.bill_no || ""),
      document_type: "Payment",
      document_date: String(row.payment_date || ""),
      due_date: "",
      status: String(row.status || ""),
      amount: -Math.abs(toNumber(row.amount)),
      currency: String(row.currency || vendor?.currency || "EUR"),
      subtotal: -Math.abs(toNumber(row.amount)),
      discount: 0,
      shipping: 0,
      total: -Math.abs(toNumber(row.amount)),
    })),
  ];

  const billAmount = bills.reduce((sum, row) => sum + toNumber(row.total_amount), 0);
  const vendorCreditAmount = vendorCredits.reduce((sum, row) => sum + toNumber(row.total_amount), 0);
  const paymentAmount = paymentsMade.reduce((sum, row) => sum + toNumber(row.amount), 0);

  return {
    invite: {
      id: invite.id,
      party_type: invite.party_type,
      party_name: invite.party_name,
      email: invite.email,
      contact_name: invite.contact_name,
      status: "active",
      access: {
        can_view_account: invite.access_can_view_account,
        can_view_invoices: invite.access_can_view_invoices,
        can_view_payments: invite.access_can_view_payments,
        can_view_orders: invite.access_can_view_orders,
      },
    },
    companyProfile: invite.party_type === "customer" ? toCustomerCompanyProfile(companyProfile) : companyProfile,
    customer: null,
    vendor,
    availableBrands: await fetchPortalAvailableBrands(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      invite.access_can_view_orders,
      portalAllowedBrandIds(invite),
    ),
    salesOrders: [],
    invoices: [],
    creditNotes: [],
    purchaseOrders: purchaseOrders.map((row) => ({
      ...row,
      total_amount: toNumber(row.total_amount),
      line_count: Number(row.line_count ?? 0) || 0,
      lines: mapPurchaseOrderLines(row.lines),
    })),
    bills: bills.map((row) => ({
      ...row,
      total_amount: toNumber(row.total_amount),
      subtotal: toNumber(row.subtotal),
        discount_amount: toNumber(row.discount_amount),
        shipping_cost: toNumber(row.shipping_cost),
        lines: mapPurchaseOrderLines(row.lines),
      })),
    vendorCredits: vendorCredits.map((row) => ({
      ...row,
      total_amount: toNumber(row.total_amount),
    })),
    paymentsReceived: [],
    paymentsMade,
    accountSummary: {
      currency: String(vendor?.currency || bills[0]?.currency || "EUR"),
      totalDocuments: accountRows.length,
      totalAmount: accountRows.reduce((sum, row) => sum + row.amount, 0),
      documentAmount: billAmount,
      creditAmount: vendorCreditAmount,
      paymentAmount,
      openAmount: accountRows.filter((row) => !["void"].includes(row.status.toLowerCase())).reduce((sum, row) => sum + row.amount, 0),
      paymentCount: paymentsMade.length,
    },
    pricingProfile: null,
    accountRows,
  };
}

export async function buildPortalBranding(supabaseUrl: string, serviceRoleKey: string, invite: PortalInviteRow) {
  if (invite.party_type === "customer") {
    let customer: Record<string, unknown> | null = null;
    try {
      customer = await fetchPortalCustomerRecord(supabaseUrl, serviceRoleKey, invite.organization_id, invite);
    } catch {
      customer = null;
    }
    const { sellerCompanyProfileId } = readCustomerPortalMetadata(customer);
    let companyProfile: Record<string, unknown> | null = null;
    try {
      companyProfile = await fetchPortalCompanyProfile(supabaseUrl, serviceRoleKey, invite.organization_id, sellerCompanyProfileId);
    } catch {
      companyProfile = null;
    }
    return {
      companyProfile: toPortalBrandingProfile(companyProfile),
      portalLabel: "Customer Portal",
      partyName: String(customer?.display_name || customer?.company_name || invite.party_name || invite.email || ""),
    };
  }

  let companyProfile: Record<string, unknown> | null = null;
  try {
    companyProfile = await fetchPortalCompanyProfile(supabaseUrl, serviceRoleKey, invite.organization_id);
  } catch {
    companyProfile = null;
  }
  return {
    companyProfile: toPortalBrandingProfile(companyProfile),
    portalLabel: "Vendor Portal",
    partyName: String(invite.party_name || invite.email || ""),
  };
}

export async function buildPortalFallbackSnapshot(supabaseUrl: string, serviceRoleKey: string, invite: PortalInviteRow) {
  let companyProfile: Record<string, unknown> | null = null;
  try {
    const branding = await buildPortalBranding(supabaseUrl, serviceRoleKey, invite);
    companyProfile = branding.companyProfile;
  } catch {
    companyProfile = null;
  }

  const baseParty = {
    display_name: invite.party_name,
    company_name: invite.party_name,
    email: invite.email,
    payment_terms: "",
    contract_nr: "",
    remarks: "",
    currency: "EUR",
  };

  // A transient customer/profile lookup failure must not erase an already
  // existing tenant-scoped document history. Rebuild the compact history
  // from the invite scope when the full snapshot cannot be assembled.
  let fallbackSalesOrders: Record<string, unknown>[] = [];
  let fallbackInvoices: Record<string, unknown>[] = [];
  if (invite.party_type === "customer" && invite.access_can_view_orders) {
    const sellerCompanyProfileId = String(invite.seller_company_profile_id || "").trim();
    const sellerCompanyProfile = await fetchPortalCompanyProfile(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      sellerCompanyProfileId,
    );
    const sellerCompanyName = String(sellerCompanyProfile?.company_name || "").trim();
    // Do not broaden a failed tenant lookup into another seller's history.
    if (sellerCompanyName) {
      const fallbackHistoryParams = buildPortalCustomerHistoryParams(
        invite.organization_id,
        String(invite.customer_id || "").trim(),
        String(invite.party_name || "").trim(),
        sellerCompanyName,
      );
      const orderSelect =
        "id,sales_order_no,customer_name,quote_date,currency,status,sales_total,source_channel,portal_submitted_at,portal_seen_at,delivery_term,payment_terms,packing_details,notes,discount_amount,shipping_cost,updated_at";
      const invoiceSelect =
        "id,sales_order_no,customer_name,quote_date,currency,status,total_amount,due_date,payment_terms,delivery_term,contract_nr,packing_details,notes,subtotal,discount_amount,shipping_cost,updated_at";
      fallbackSalesOrders = await fetchPortalHistoryRows(
        supabaseUrl,
        serviceRoleKey,
        "sales_orders",
        "",
        orderSelect,
        fallbackHistoryParams,
      );
      if (invite.access_can_view_invoices) {
        fallbackInvoices = await fetchPortalHistoryRows(
          supabaseUrl,
          serviceRoleKey,
          "invoices",
          "",
          invoiceSelect,
          fallbackHistoryParams,
        );
      }
    }
  }

  const fallbackAccountRows = fallbackInvoices.map((row) => ({
    document_no: String(row.id || row.sales_order_no || ""),
    document_type: "Invoice",
    document_date: String(row.quote_date || ""),
    due_date: String(row.due_date || ""),
    status: String(row.status || ""),
    amount: toNumber(row.total_amount),
    currency: String(row.currency || "EUR"),
    subtotal: toNumber(row.total_amount),
    discount: 0,
    shipping: 0,
    total: toNumber(row.total_amount),
  }));
  const fallbackInvoiceAmount = fallbackInvoices.reduce((sum, row) => sum + toNumber(row.total_amount), 0);

  return {
    invite: {
      id: invite.id,
      party_type: invite.party_type,
      party_name: invite.party_name,
      email: invite.email,
      contact_name: invite.contact_name,
      status: "active",
      access: {
        can_view_account: invite.access_can_view_account,
        can_view_invoices: invite.access_can_view_invoices,
        can_view_payments: invite.access_can_view_payments,
        can_view_orders: invite.access_can_view_orders,
      },
    },
    companyProfile,
    customer: invite.party_type === "customer" ? baseParty : null,
    vendor: invite.party_type === "vendor" ? baseParty : null,
    availableBrands: await fetchPortalAvailableBrands(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      invite.access_can_view_orders,
      portalAllowedBrandIds(invite),
    ),
    salesOrders: fallbackSalesOrders.map((row) => ({
      ...row,
      source_channel: String(row.source_channel || "internal"),
      portal_submitted_at: row.portal_submitted_at ? String(row.portal_submitted_at) : null,
      portal_seen_at: row.portal_seen_at ? String(row.portal_seen_at) : null,
      sales_total: toNumber(row.sales_total),
      discount_amount: toNumber(row.discount_amount),
      shipping_cost: toNumber(row.shipping_cost),
      lines: [],
    })),
    purchaseOrders: [],
    invoices: fallbackInvoices.map((row) => ({
      ...row,
      total_amount: toNumber(row.total_amount),
      subtotal: toNumber(row.subtotal),
      discount_amount: toNumber(row.discount_amount),
      shipping_cost: toNumber(row.shipping_cost),
      lines: [],
    })),
    bills: [],
    creditNotes: [],
    vendorCredits: [],
    paymentsReceived: [],
    paymentsMade: [],
    accountSummary: {
      currency: "EUR",
      totalDocuments: fallbackAccountRows.length,
      totalAmount: fallbackAccountRows.reduce((sum, row) => sum + row.amount, 0),
      documentAmount: fallbackInvoiceAmount,
      creditAmount: 0,
      paymentAmount: 0,
      openAmount: fallbackAccountRows.filter((row) => !["void"].includes(row.status.toLowerCase())).reduce((sum, row) => sum + row.amount, 0),
      paymentCount: 0,
    },
    pricingProfile: null,
    accountRows: fallbackAccountRows,
  };
}
