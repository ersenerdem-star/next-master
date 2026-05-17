import { buildRestUrl, getJson, sendJson, serviceRoleHeaders } from "./http.mts";
import { buildPortalSnapshot } from "./portal-access.mts";

type PortalInviteRow = {
  id: string;
  organization_id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  email: string;
  contact_name: string;
  status: "draft" | "invited" | "active" | "disabled";
  invite_token: string;
  access_can_view_account: boolean;
  access_can_view_invoices: boolean;
  access_can_view_payments: boolean;
  access_can_view_orders: boolean;
};

type CustomerRow = {
  id: string;
  display_name: string;
  company_name: string;
  currency: string;
  payment_terms: string;
  contract_nr: string;
  price_list_type: string;
  price_list_margin_percent: number | null;
};

type CompanyProfileRow = {
  company_name: string;
};

type PortalCatalogSearchItem = {
  code: string;
  brand: string;
  description: string;
  oem_no: string;
  tariff: string;
  origin: string;
  weight_kg: number | null;
};

type PortalOrderInputRow = {
  code: string;
  brand: string;
  qty: number;
};

type PreparedPortalLine = {
  lineId: string;
  requestedCode: string;
  resolvedCode: string;
  brand: string;
  description: string;
  qty: number;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  supplier_name: string;
  buy_price: number | null;
  sell_price: number | null;
  c_sell_price: number | null;
  price_date: string;
  notes: string;
  found: boolean;
  codeChanged: boolean;
  codeChangeWarning: string;
  supplierOptions: Array<{
    supplier_id?: string | null;
    supplier_name: string;
    buy_price: number | null;
    price_date: string | null;
    sell_price: number | null;
    notes: string | null;
  }>;
  selectedSupplierKey: string;
};

type CustomerPricingContext = {
  organizationId: string;
  customer: CustomerRow;
  sellerCompany: string;
  currency: string;
  customerType: "A" | "B" | "C" | "Other";
  effectiveMarginA: number;
  effectiveMarginB: number;
  cPriceListId: string;
};

function normalizePartCode(value: string) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizePortalCustomerType(value: string): CustomerPricingContext["customerType"] {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "a" || normalized === "a price list") return "A";
  if (normalized === "b" || normalized === "b price list") return "B";
  if (normalized === "c" || normalized === "c price list") return "C";
  if (normalized === "other" || normalized === "other margin") return "Other";
  return "A";
}

function computeSellFromBuy(buyPrice: number | null, context: CustomerPricingContext) {
  if (buyPrice == null) return null;
  if (context.customerType === "C") return null;
  const marginPercent = context.customerType === "B" ? context.effectiveMarginB : context.effectiveMarginA;
  return roundMoney(Number(buyPrice) * (1 + marginPercent / 100));
}

function hasUsablePrice(value: unknown) {
  return value != null && Number(value) > 0;
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function rpcUrl(supabaseUrl: string, fn: string) {
  return new URL(`/rest/v1/rpc/${fn}`, supabaseUrl).toString();
}

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

async function callRpc<T>(supabaseUrl: string, serviceRoleKey: string, fn: string, payload: Record<string, unknown>) {
  return sendJson<T>(rpcUrl(supabaseUrl, fn), {
    method: "POST",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify(payload),
  });
}

async function resolvePortalCustomer(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
): Promise<CustomerPricingContext> {
  if (invite.party_type !== "customer" || !invite.access_can_view_orders) {
    throw new Error("This portal cannot create sales orders");
  }

  const customer =
    (await fetchFirst<CustomerRow>(supabaseUrl, serviceRoleKey, "customers", {
      select: "id,display_name,company_name,currency,payment_terms,contract_nr,price_list_type,price_list_margin_percent",
      organization_id: `eq.${invite.organization_id}`,
      display_name: `eq.${invite.party_name}`,
    })) ||
    (await fetchFirst<CustomerRow>(supabaseUrl, serviceRoleKey, "customers", {
      select: "id,display_name,company_name,currency,payment_terms,contract_nr,price_list_type,price_list_margin_percent",
      organization_id: `eq.${invite.organization_id}`,
      company_name: `eq.${invite.party_name}`,
    }));

  if (!customer?.id) {
    throw new Error(`Customer card not found for ${invite.party_name}`);
  }

  const companyProfile =
    (await fetchFirst<CompanyProfileRow>(supabaseUrl, serviceRoleKey, "company_profiles", {
      select: "company_name",
      organization_id: `eq.${invite.organization_id}`,
      order: "updated_at.desc",
    })) || null;

  const priceLists = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customer_price_lists", {
    select: "id,list_type,margin_percent,is_active",
    organization_id: `eq.${invite.organization_id}`,
    is_active: "eq.true",
    order: "updated_at.desc",
  });

  const byType = new Map<string, Record<string, unknown>>();
  for (const row of priceLists) {
    const type = String(row.list_type || "");
    if (!type || byType.has(type)) continue;
    byType.set(type, row);
  }

  const defaultMarginA = byType.get("A")?.margin_percent == null ? 10 : Number(byType.get("A")?.margin_percent || 10);
  const defaultMarginB = byType.get("B")?.margin_percent == null ? 15 : Number(byType.get("B")?.margin_percent || 15);
  const priceListType = normalizePortalCustomerType(String(customer.price_list_type || "A"));
  const marginOverride = customer.price_list_margin_percent == null ? null : Number(customer.price_list_margin_percent);
  const effectiveMarginA = (priceListType === "A" || priceListType === "Other") && marginOverride != null ? marginOverride : defaultMarginA;
  const effectiveMarginB = priceListType === "B" && marginOverride != null ? marginOverride : defaultMarginB;
  const cPriceListId = String(byType.get("C")?.id || "");

  return {
    organizationId: invite.organization_id,
    customer,
    sellerCompany: String(companyProfile?.company_name || ""),
    currency: String(customer.currency || "EUR"),
    customerType: priceListType,
    effectiveMarginA,
    effectiveMarginB,
    cPriceListId,
  };
}

async function resolveBrandMap(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  const brands = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "brands", {
    select: "id,name",
    organization_id: `eq.${organizationId}`,
    order: "name.asc",
  });
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const row of brands) {
    const id = String(row.id || "");
    const name = String(row.name || "").trim();
    if (!id || !name) continue;
    byId.set(id, name);
    byName.set(name.toLowerCase(), id);
  }
  return { byId, byName };
}

export async function searchPortalCatalog(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  query: string,
  brand: string,
): Promise<PortalCatalogSearchItem[]> {
  const customerContext = await resolvePortalCustomer(supabaseUrl, serviceRoleKey, invite);
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, invite.organization_id);
  const search = String(query || "").trim();
  const selectedBrandId = brand ? brandMap.byName.get(brand.trim().toLowerCase()) || "" : "";
  const params: Record<string, string> = {
    select: "product_code,description,oem_no,hs_code,origin,weight_kg,brand_id",
    organization_id: `eq.${invite.organization_id}`,
    order: "product_code.asc",
    limit: "50",
  };

  if (selectedBrandId) params.brand_id = `eq.${selectedBrandId}`;
  if (search) {
    const escaped = search.replaceAll(",", " ").replaceAll("(", "").replaceAll(")", "");
    params.or = `(product_code.ilike.*${escaped}*,description.ilike.*${escaped}*,oem_no.ilike.*${escaped}*)`;
  }

  const rows = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", params);
  return rows.map((row) => ({
    code: String(row.product_code || ""),
    brand: brandMap.byId.get(String(row.brand_id || "")) || "",
    description: String(row.description || ""),
    oem_no: String(row.oem_no || ""),
    tariff: String(row.hs_code || ""),
    origin: String(row.origin || ""),
    weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
  }));
}

function mergeInputRows(rows: PortalOrderInputRow[]) {
  const grouped = new Map<string, PortalOrderInputRow>();
  for (const row of rows) {
    const code = String(row.code || "").trim();
    const brand = String(row.brand || "").trim();
    const qty = Math.max(1, Number(row.qty || 1) || 1);
    if (!code || !brand) continue;
    const key = `${brand.toLowerCase()}::${normalizePartCode(code)}`;
    const current = grouped.get(key);
    if (current) {
      current.qty += qty;
    } else {
      grouped.set(key, { code, brand, qty });
    }
  }
  return [...grouped.values()];
}

async function fetchCPriceMap(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  cPriceListId: string,
  rows: Array<{ brand: string; product_code: string }>,
) {
  const map = new Map<string, number>();
  if (!cPriceListId || !rows.length) return map;
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, organizationId);
  const brandIds = [...new Set(rows.map((row) => brandMap.byName.get(row.brand.trim().toLowerCase()) || "").filter(Boolean))];
  const normalizedCodes = [...new Set(rows.map((row) => normalizePartCode(row.product_code)).filter(Boolean))];
  if (!brandIds.length || !normalizedCodes.length) return map;

  const items = await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customer_price_list_items", {
    select: "brand_id,normalized_code,sell_price",
    organization_id: `eq.${organizationId}`,
    price_list_id: `eq.${cPriceListId}`,
    brand_id: `in.(${brandIds.join(",")})`,
    normalized_code: `in.(${normalizedCodes.join(",")})`,
  });

  for (const row of items) {
    const brandName = brandMap.byId.get(String(row.brand_id || ""));
    const normalizedCode = String(row.normalized_code || "");
    if (!brandName || !normalizedCode) continue;
    map.set(`${brandName.toLowerCase()}::${normalizedCode}`, Number(row.sell_price || 0));
  }

  return map;
}

async function resolvePortalCatalogSupplierData(
  supabaseUrl: string,
  serviceRoleKey: string,
  context: CustomerPricingContext,
  row: PortalOrderInputRow,
  codeToResolve: string,
) {
  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, context.organizationId);
  const brandId = brandMap.byName.get(row.brand.trim().toLowerCase()) || "";
  const normalizedCode = normalizePartCode(codeToResolve);
  if (!brandId || !normalizedCode) {
    return {
      catalogMatch: null as Record<string, unknown> | null,
      supplierOptions: [] as Array<{
        supplier_id?: string | null;
        supplier_name: string;
        buy_price: number | null;
        price_date: string | null;
        sell_price: number | null;
        notes: string | null;
      }>,
    };
  }

  const [catalogExact, catalogOem, supplierExact, supplierOem] = await Promise.all([
    fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
      select: "product_code,description,oem_no,hs_code,origin,weight_kg,brand_id,normalized_code,normalized_oem",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      normalized_code: `eq.${normalizedCode}`,
    }),
    fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "catalog_products", {
      select: "product_code,description,oem_no,hs_code,origin,weight_kg,brand_id,normalized_code,normalized_oem",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      normalized_oem: `eq.${normalizedCode}`,
    }),
    fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "supplier_prices", {
      select: "supplier_id,brand_id,product_code,normalized_code,normalized_oem,description,oem_no,buy_price,valid_from,notes,suppliers(name)",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      is_active: "eq.true",
      normalized_code: `eq.${normalizedCode}`,
      order: "buy_price.asc",
      limit: "50",
    }),
    fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "supplier_prices", {
      select: "supplier_id,brand_id,product_code,normalized_code,normalized_oem,description,oem_no,buy_price,valid_from,notes,suppliers(name)",
      organization_id: `eq.${context.organizationId}`,
      brand_id: `eq.${brandId}`,
      is_active: "eq.true",
      normalized_oem: `eq.${normalizedCode}`,
      order: "buy_price.asc",
      limit: "50",
    }),
  ]);

  const supplierMatchesRaw = [...(supplierExact || []), ...(supplierOem || [])].filter((item) => item.buy_price != null);
  const supplierMap = new Map<
    string,
    {
      supplier_id?: string | null;
      supplier_name: string;
      buy_price: number | null;
      price_date: string | null;
      sell_price: number | null;
      notes: string | null;
    }
  >();

  for (const item of supplierMatchesRaw) {
    const supplierId = item.supplier_id == null ? null : String(item.supplier_id);
    const supplierName = String(item.suppliers?.name || "");
    if (!supplierName) continue;
    const buyPrice = item.buy_price == null ? null : Number(item.buy_price);
    const key = `${supplierId || ""}::${supplierName}`;
    const current = supplierMap.get(key);
    if (!current || Number(buyPrice ?? Number.MAX_SAFE_INTEGER) < Number(current.buy_price ?? Number.MAX_SAFE_INTEGER)) {
      supplierMap.set(key, {
        supplier_id: supplierId,
        supplier_name: supplierName,
        buy_price: buyPrice,
        sell_price: computeSellFromBuy(buyPrice, context),
        price_date: item.valid_from == null ? null : String(item.valid_from),
        notes: item.notes == null ? null : String(item.notes),
      });
    }
  }

  return {
    catalogMatch: catalogExact || catalogOem || null,
    supplierOptions: [...supplierMap.values()].sort(
      (a, b) => Number(a.buy_price ?? Number.MAX_SAFE_INTEGER) - Number(b.buy_price ?? Number.MAX_SAFE_INTEGER),
    ),
  };
}

async function findPortalCodeReferenceMatch(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  brand: string,
  code: string,
) {
  const normalizedCode = normalizePartCode(code);
  if (!brand.trim() || !normalizedCode) return null;

  const brandMap = await resolveBrandMap(supabaseUrl, serviceRoleKey, organizationId);
  const brandId = brandMap.byName.get(brand.trim().toLowerCase());
  if (!brandId) return null;

  const row = await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "item_code_references", {
    select: "id,old_code,new_code,reason,original_number",
    organization_id: `eq.${organizationId}`,
    brand_id: `eq.${brandId}`,
    is_active: "eq.true",
    normalized_old_code: `eq.${normalizedCode}`,
  });

  if (!row?.id) return null;
  return {
    id: String(row.id || ""),
    old_code: String(row.old_code || ""),
    new_code: String(row.new_code || ""),
    reason: String(row.reason || ""),
    original_number: String(row.original_number || ""),
  };
}

async function fetchSupplierOptions(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: PortalOrderInputRow,
  context: CustomerPricingContext,
) {
  const supplierCustomerType = context.customerType === "B" ? "B" : "A";
  const options = await callRpc<Array<Record<string, unknown>>>(supabaseUrl, serviceRoleKey, "cloud_quote_supplier_options", {
    input_code: row.code.trim(),
    input_brand: row.brand.trim(),
    input_customer_type: supplierCustomerType,
    input_margin_a: context.effectiveMarginA / 100,
    input_margin_b: context.effectiveMarginB / 100,
  });

  return (options || []).map((option) => {
    const buyPrice = option.buy_price == null ? null : Number(option.buy_price);
    const sellPrice =
      option.sell_price == null ? computeSellFromBuy(buyPrice, context) : Number(option.sell_price);
    return {
      supplier_id: option.supplier_id == null ? null : String(option.supplier_id),
      supplier_name: String(option.supplier_name || ""),
      buy_price: buyPrice,
      sell_price: sellPrice,
      price_date: String(option.price_date || ""),
      notes: String(option.notes || ""),
    };
  });
}

async function fetchBestSupplierOption(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: PortalOrderInputRow,
  context: CustomerPricingContext,
) {
  const first = (await fetchSupplierOptions(supabaseUrl, serviceRoleKey, row, context))[0];
  if (!first) return null;
  return {
    supplier_name: String(first.supplier_name || ""),
    buy_price: first.buy_price == null ? null : Number(first.buy_price),
    sell_price: first.sell_price == null ? null : Number(first.sell_price),
    price_date: String(first.price_date || ""),
    notes: String(first.notes || ""),
  };
}

async function resolvePreparedLine(
  supabaseUrl: string,
  serviceRoleKey: string,
  row: PortalOrderInputRow,
  context: CustomerPricingContext,
): Promise<PreparedPortalLine> {
  const referenceMatch = await findPortalCodeReferenceMatch(
    supabaseUrl,
    serviceRoleKey,
    context.organizationId,
    row.brand,
    row.code,
  );
  const codeToResolve = referenceMatch?.new_code || row.code;
  const { catalogMatch, supplierOptions } = await resolvePortalCatalogSupplierData(
    supabaseUrl,
    serviceRoleKey,
    context,
    row,
    codeToResolve,
  );
  const fallbackSupplier = supplierOptions[0] || null;
  const resolvedCode = String(catalogMatch?.product_code || codeToResolve || row.code || "");
  const codeChanged = Boolean(referenceMatch) || normalizePartCode(resolvedCode) !== normalizePartCode(row.code);
  const buyPrice = fallbackSupplier?.buy_price ?? null;
  const computedSell =
    context.customerType === "C"
      ? null
      : fallbackSupplier?.sell_price ?? computeSellFromBuy(buyPrice, context);

  return {
    lineId: makeId("portal-line"),
    requestedCode: row.code,
    resolvedCode,
    brand: row.brand || "",
    description: String(catalogMatch?.description || ""),
    qty: row.qty,
    oem_no: String(catalogMatch?.oem_no || ""),
    hs_code: String(catalogMatch?.hs_code || ""),
    origin: String(catalogMatch?.origin || ""),
    weight_kg: catalogMatch?.weight_kg == null ? null : Number(catalogMatch.weight_kg),
    supplier_name: String(fallbackSupplier?.supplier_name || ""),
    buy_price: buyPrice,
    sell_price: computedSell,
    c_sell_price: null,
    price_date: String(fallbackSupplier?.price_date || ""),
    notes: String(fallbackSupplier?.notes || ""),
    found: Boolean(catalogMatch || fallbackSupplier?.supplier_name || buyPrice != null || computedSell != null),
    codeChanged,
    codeChangeWarning: referenceMatch
      ? `Old Code ${referenceMatch.old_code} => New Code ${referenceMatch.new_code}.${referenceMatch.reason ? ` ${referenceMatch.reason}` : ""}`
      : codeChanged
        ? `Old Code ${row.code} => New Code ${resolvedCode}`
        : "",
    supplierOptions,
    selectedSupplierKey: supplierOptions[0] ? `${supplierOptions[0].supplier_name}-0` : "",
  };
}

export async function preparePortalOrderLines(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  rows: PortalOrderInputRow[],
) {
  const context = await resolvePortalCustomer(supabaseUrl, serviceRoleKey, invite);
  const mergedRows = mergeInputRows(rows);
  const prepared: PreparedPortalLine[] = [];

  for (let index = 0; index < mergedRows.length; index += 10) {
    const chunk = mergedRows.slice(index, index + 10);
    const resolvedChunk = await Promise.all(chunk.map((row) => resolvePreparedLine(supabaseUrl, serviceRoleKey, row, context)));
    prepared.push(...resolvedChunk);
  }

  if (context.customerType === "C" && prepared.length) {
    const cPriceMap = await fetchCPriceMap(
      supabaseUrl,
      serviceRoleKey,
      invite.organization_id,
      context.cPriceListId,
      prepared.map((row) => ({
        brand: row.brand,
        product_code: row.resolvedCode,
      })),
    );
    prepared.forEach((line) => {
      const value = cPriceMap.get(`${line.brand.trim().toLowerCase()}::${normalizePartCode(line.resolvedCode)}`);
      line.c_sell_price = value == null ? null : Number(value);
      line.sell_price = value == null ? line.sell_price : Number(value);
    });
  }

  return {
    lines: prepared,
    pricingProfile: {
      currency: context.currency,
      payment_terms: context.customer.payment_terms || "",
      contract_nr: context.customer.contract_nr || "",
    },
  };
}

export async function submitPortalSalesOrder(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  input: {
    orderId?: string;
    salesOrderNo?: string;
    mode: "draft" | "confirm";
    deliveryTerm?: string;
    paymentTerms?: string;
    packingDetails?: string;
    notes?: string;
    rows: PortalOrderInputRow[];
  },
) {
  const context = await resolvePortalCustomer(supabaseUrl, serviceRoleKey, invite);
  const prepared = await preparePortalOrderLines(supabaseUrl, serviceRoleKey, invite, input.rows);
  const lines = prepared.lines.filter((line) => line.qty > 0 && line.resolvedCode);
  if (!lines.length) throw new Error("No valid order lines found");

  const existing =
    input.orderId
      ? await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "sales_orders", {
          select: "id,sales_order_no,status,created_at,portal_submitted_at,portal_seen_at",
          organization_id: `eq.${invite.organization_id}`,
          id: `eq.${input.orderId}`,
          customer_name: `eq.${invite.party_name}`,
        })
      : null;

  if (existing?.status === "confirmed") {
    throw new Error("Internally confirmed sales orders cannot be edited from portal");
  }

  const purchaseTotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.buy_price || 0) * line.qty, 0));
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.sell_price || 0) * line.qty, 0));
  const totalAmount = subtotal;
  const profitTotal = roundMoney(totalAmount - purchaseTotal);
  const marginPercent = totalAmount > 0 ? roundMoney((profitTotal / totalAmount) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const salesOrderNo =
    String(existing?.sales_order_no || input.salesOrderNo || "").trim() ||
    `PORTAL-${today.replaceAll("-", "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const payload = {
    id: String(existing?.id || input.orderId || makeId("so")),
    organization_id: invite.organization_id,
    sales_order_no: salesOrderNo,
    customer_name: invite.party_name,
    seller_company: context.sellerCompany,
    purchase_company: "",
    quote_date: today,
    currency: context.currency,
    customer_type: context.customerType,
    shipping_cost: 0,
    discount_amount: 0,
    supplier_mode: "Best price",
    preferred_supplier: "",
    seller_info: context.customer.contract_nr || "",
    buyer_info: "",
    delivery_term: String(input.deliveryTerm || ""),
    payment_terms: String(input.paymentTerms || context.customer.payment_terms || ""),
    packing_details: String(input.packingDetails || ""),
    notes: String(input.notes || ""),
    status: "draft",
    purchase_total: purchaseTotal,
    sales_total: totalAmount,
    profit_total: profitTotal,
    margin_percent: marginPercent,
    source_channel: "portal",
    portal_invite_id: invite.id,
    portal_submitted_at: input.mode === "confirm" ? nowIso() : existing?.portal_submitted_at || null,
    portal_seen_at: input.mode === "confirm" ? null : existing?.portal_seen_at || null,
    confirmed_at: null,
    lines,
    created_at: String(existing?.created_at || nowIso()),
    updated_at: nowIso(),
  };

  const rows = await sendJson<Array<Record<string, unknown>>>(
    `${buildRestUrl(supabaseUrl, "sales_orders", { on_conflict: "id", select: "id" })}`,
    {
      method: "POST",
      headers: {
        ...serviceRoleHeaders(serviceRoleKey),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    },
  );

  const savedId = String(rows[0]?.id || payload.id);
  const snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, invite);
  return { orderId: savedId, snapshot };
}
