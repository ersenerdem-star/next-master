import { buildRestUrl, getJson, serviceRoleHeaders } from "./http.mts";
import { normalizeLifecycleStatus, sanitizeCatalogOemNumbers } from "./catalog-standardization.mts";
import { createPortalSessionToken, hashPortalToken, verifyPortalSessionToken } from "./portal-security.mts";

export type PortalInviteRow = {
  id: string;
  organization_id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  customer_id: string | null;
  vendor_id: string | null;
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
  updated_at: string | null;
};

const PORTAL_INVITE_SELECT =
  "id,organization_id,party_type,party_name,customer_id,vendor_id,email,contact_name,status,invite_token_hash,last_sent_at,expires_at,last_used_at,access_can_view_account,access_can_view_invoices,access_can_view_payments,access_can_view_orders,updated_at";

const CUSTOMER_PORTAL_SELECT =
  "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,remarks,custom_fields,seller_company_profile_id,price_list_type,portal_c_price_mode";
const CUSTOMER_PORTAL_SELECT_LEGACY =
  "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,remarks,custom_fields,price_list_type";
const CUSTOMER_PORTAL_SELECT_BASE =
  "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,remarks,custom_fields";
const CUSTOMER_META_PREFIX = "[[NEXT_MASTER_META]]";
const COMPANY_PROFILE_SELECT = "id,company_name,email,phone,website,address,bank_details,tax_office,tax_number,footer_note,logo_data_url";

async function fetchFirst<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  const rows = await getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
  });
  return rows[0] || null;
}

async function fetchAll<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  return getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
  });
}

function isPortalSoftFailure(error: unknown) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return (
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
  const trySelect = async (select: string) =>
    (invite.customer_id
      ? await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customers", {
          select,
          organization_id: `eq.${organizationId}`,
          id: `eq.${invite.customer_id}`,
        })
      : null) ||
    (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customers", {
      select,
      organization_id: `eq.${organizationId}`,
      display_name: `eq.${invite.party_name}`,
    })) ||
    (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customers", {
      select,
      organization_id: `eq.${organizationId}`,
      company_name: `eq.${invite.party_name}`,
    })) ||
    (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customers", {
      select,
      organization_id: `eq.${organizationId}`,
      email: `eq.${String(invite.email || "").trim().toLowerCase()}`,
    }));

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
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
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
) {
  if (!enabled) return [];
  const direct = normalizeBrandNameList(
    (
      await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "brands", {
        select: "name",
        organization_id: `eq.${organizationId}`,
        order: "name.asc",
      })
    ).map((row) => String(row.name || "")),
  );
  if (direct.length) return direct;

  const fallback = normalizeBrandNameList(
    (
      await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
        select: "brand_id,brands(name)",
        organization_id: `eq.${organizationId}`,
        order: "brand_id.asc",
        limit: "5000",
      })
    ).map((row) => extractRelatedBrandName(row)),
  );
  return fallback;
}

function mapSalesOrderLines(lines: unknown) {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => {
    const row = (line || {}) as Record<string, unknown>;
    const qty = toNumber(row.qty);
    const sellPrice = row.sell_price == null ? null : toNumber(row.sell_price);
    const purchaseTotal = row.buy_price == null ? null : toNumber(row.buy_price) * qty;
    const salesTotal = sellPrice == null ? null : sellPrice * qty;
    const lifecycleStatus = normalizeLifecycleStatus(`${String(row.lifecycle_status || "")} ${String(row.lifecycle_note || "")}`);
    const lifecycleNote = String(row.lifecycle_note || "").trim() || null;
    const resolvedCode = String(row.resolvedCode || row.requestedCode || "");
    return {
      code: resolvedCode,
      requested_code: String(row.requestedCode || ""),
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

async function fetchPortalInviteByEmailPreview(supabaseUrl: string, serviceRoleKey: string, email: string) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return null;
  const invites = await fetchAllOptional<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
    select: PORTAL_INVITE_SELECT,
    email: `eq.${normalizedEmail}`,
    order: "updated_at.desc",
    limit: "10",
  });
  return invites.find((invite) => invite.status !== "disabled") || null;
}

export async function fetchPortalInviteByEmail(supabaseUrl: string, serviceRoleKey: string, email: string) {
  return fetchPortalInviteByEmailPreview(supabaseUrl, serviceRoleKey, email);
}

export async function fetchPortalInviteByIdAndEmail(
  supabaseUrl: string,
  serviceRoleKey: string,
  inviteId: string,
  email: string,
) {
  return fetchFirst<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
    select: PORTAL_INVITE_SELECT,
    id: `eq.${inviteId}`,
    email: `eq.${String(email || "").trim().toLowerCase()}`,
    limit: "1",
  });
}

export async function validatePortalInvite(supabaseUrl: string, serviceRoleKey: string, email: string, password: string) {
  const tokenHash = await hashPortalToken(password);
  let invite: PortalInviteRow | null = null;

  try {
    invite = await fetchFirst<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
      select: PORTAL_INVITE_SELECT,
      email: `eq.${email}`,
      invite_token_hash: `eq.${tokenHash}`,
    });
  } catch {
    invite = null;
  }

  if (!invite || invite.status === "disabled") {
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
  },
) {
  const providedPassword = String(auth.password || "").trim();
  const sessionToken = String(auth.sessionToken || "").trim();
  const providedEmail = String(auth.email || "").trim().toLowerCase();

  if (!providedPassword && sessionToken) {
    const session = await verifyPortalSessionToken(sessionSecret, sessionToken);
    if (!session) {
      throw new Error("Portal session expired. Sign in again.");
    }

    const invite = await fetchFirst<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
      select: PORTAL_INVITE_SELECT,
      id: `eq.${session.invite_id}`,
      email: `eq.${session.email}`,
    });

    if (!invite || invite.status === "disabled") {
      throw new Error("Portal session is no longer active.");
    }

    await touchPortalInvite(supabaseUrl, serviceRoleKey, invite);
    return { invite, sessionToken };
  }

  const email = providedEmail;
  if (!email || !providedPassword) {
    throw new Error("Email and password are required");
  }

  const invite = await validatePortalInvite(supabaseUrl, serviceRoleKey, email, providedPassword);
  const nextSessionToken = await createPortalSessionToken(sessionSecret, invite.id, invite.email);
  return { invite, sessionToken: nextSessionToken };
}

export async function resolvePortalInvitePreview(
  supabaseUrl: string,
  serviceRoleKey: string,
  sessionSecret: string,
  auth: {
    email?: string | null;
    sessionToken?: string | null;
  },
) {
  const sessionToken = String(auth.sessionToken || "").trim();
  if (sessionToken) {
    const session = await verifyPortalSessionToken(sessionSecret, sessionToken);
    if (!session) {
      throw new Error("Portal session expired. Sign in again.");
    }
    const invite = await fetchFirst<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
      select: PORTAL_INVITE_SELECT,
      id: `eq.${session.invite_id}`,
      email: `eq.${session.email}`,
    });
    if (!invite || invite.status === "disabled") {
      throw new Error("Portal session is no longer active.");
    }
    return { invite, sessionToken };
  }

  const invite = await fetchPortalInviteByEmailPreview(supabaseUrl, serviceRoleKey, auth.email || "");
  if (!invite) {
    throw new Error("Portal invite not found or disabled");
  }
  return { invite, sessionToken: "" };
}

export async function buildPortalSnapshot(supabaseUrl: string, serviceRoleKey: string, invite: PortalInviteRow) {
  if (invite.party_type === "customer") {
    const customer = await fetchPortalCustomerRecord(supabaseUrl, serviceRoleKey, invite.organization_id, invite);
    const { customerMeta, sellerCompanyProfileId, portalCPriceMode } = readCustomerPortalMetadata(customer);
    const companyProfile = await fetchPortalCompanyProfile(supabaseUrl, serviceRoleKey, invite.organization_id, sellerCompanyProfileId);

    const customerName = String(customer?.display_name || customer?.company_name || invite.party_name);
    const customerId = String(customer?.id || invite.customer_id || "");

    const salesOrders = invite.access_can_view_orders
      ? dedupeById([
          ...(customerId
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "sales_orders", {
                select:
                  "id,sales_order_no,customer_name,quote_date,currency,status,sales_total,source_channel,portal_submitted_at,portal_seen_at,delivery_term,payment_terms,packing_details,notes,discount_amount,shipping_cost,updated_at,lines",
                organization_id: `eq.${invite.organization_id}`,
                customer_id: `eq.${customerId}`,
                order: "updated_at.desc",
              })
            : []),
          ...((!customerId || customerName)
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "sales_orders", {
                select:
                  "id,sales_order_no,customer_name,quote_date,currency,status,sales_total,source_channel,portal_submitted_at,portal_seen_at,delivery_term,payment_terms,packing_details,notes,discount_amount,shipping_cost,updated_at,lines",
                organization_id: `eq.${invite.organization_id}`,
                customer_name: `eq.${customerName}`,
                order: "updated_at.desc",
              })
            : []),
        ])
      : [];

    const invoices = invite.access_can_view_invoices
      ? dedupeById([
          ...(customerId
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "invoices", {
                select:
                  "id,sales_order_no,customer_name,quote_date,currency,status,total_amount,due_date,payment_terms,delivery_term,contract_nr,packing_details,notes,subtotal,discount_amount,shipping_cost,updated_at,lines",
                organization_id: `eq.${invite.organization_id}`,
                customer_id: `eq.${customerId}`,
                order: "updated_at.desc",
              })
            : []),
          ...((!customerId || customerName)
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "invoices", {
                select:
                  "id,sales_order_no,customer_name,quote_date,currency,status,total_amount,due_date,payment_terms,delivery_term,contract_nr,packing_details,notes,subtotal,discount_amount,shipping_cost,updated_at,lines",
                organization_id: `eq.${invite.organization_id}`,
                customer_name: `eq.${customerName}`,
                order: "updated_at.desc",
              })
            : []),
        ])
      : [];

    const paymentsReceived = invite.access_can_view_payments
      ? dedupeById([
          ...(customerId
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_received", {
                select: "id,invoice_no,customer_name,status,received_date,method,reference_no,amount,currency,updated_at",
                organization_id: `eq.${invite.organization_id}`,
                customer_id: `eq.${customerId}`,
                order: "updated_at.desc",
              })
            : []),
          ...((!customerId || customerName)
            ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_received", {
                select: "id,invoice_no,customer_name,status,received_date,method,reference_no,amount,currency,updated_at",
                organization_id: `eq.${invite.organization_id}`,
                customer_name: `eq.${customerName}`,
                order: "updated_at.desc",
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
        })
      : [];

    const availableBrands = await fetchPortalAvailableBrands(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      invite.access_can_view_orders,
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
      companyProfile,
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
        lines: mapSalesOrderLines(row.lines),
      })),
      invoices: invoices.map((row) => ({
        ...row,
        total_amount: toNumber(row.total_amount),
        subtotal: toNumber(row.subtotal),
        discount_amount: toNumber(row.discount_amount),
        shipping_cost: toNumber(row.shipping_cost),
        lines: mapInvoiceLines(row.lines),
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
            })
          : []),
        ...((!vendorId || vendorName)
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "purchase_orders", {
              select: "id,sales_order_no,supplier_name,customer_name,status,currency,total_amount,line_count,notes,updated_at,lines",
              organization_id: `eq.${invite.organization_id}`,
              supplier_name: `eq.${vendorName}`,
              order: "updated_at.desc",
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
            })
          : []),
        ...((!vendorId || vendorName)
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "bills", {
              select:
                "id,purchase_order_no,supplier_name,status,currency,total_amount,bill_date,due_date,payment_terms,notes,subtotal,discount_amount,shipping_cost,updated_at,lines",
              organization_id: `eq.${invite.organization_id}`,
              supplier_name: `eq.${vendorName}`,
              order: "updated_at.desc",
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
            })
          : []),
        ...((!vendorId || vendorName)
          ? await fetchAllOptional<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_made", {
              select: "id,bill_no,supplier_name,status,payment_date,method,reference_no,amount,currency,updated_at",
              organization_id: `eq.${invite.organization_id}`,
              supplier_name: `eq.${vendorName}`,
              order: "updated_at.desc",
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
    companyProfile,
    customer: null,
    vendor,
    availableBrands: await fetchPortalAvailableBrands(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      invite.access_can_view_orders,
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
      companyProfile,
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
    companyProfile,
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
    ),
    salesOrders: [],
    purchaseOrders: [],
    invoices: [],
    bills: [],
    creditNotes: [],
    vendorCredits: [],
    paymentsReceived: [],
    paymentsMade: [],
    accountSummary: {
      currency: "EUR",
      totalDocuments: 0,
      totalAmount: 0,
      documentAmount: 0,
      creditAmount: 0,
      paymentAmount: 0,
      openAmount: 0,
      paymentCount: 0,
    },
    pricingProfile: null,
    accountRows: [],
  };
}
