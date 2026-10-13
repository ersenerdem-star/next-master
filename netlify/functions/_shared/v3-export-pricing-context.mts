import { deriveCustomerPriceListSettings, parseEmbeddedCustomerMeta } from "./pricing/customer-pricing-context.mts";

type QueryClient = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

type ExportInvite = {
  id: string;
  organization_id: string;
  customer_id: string;
  party_type: string;
  status: string;
  access_can_view_orders: boolean;
  allowed_brand_ids?: string[] | null;
  seller_company_profile_id?: string | null;
};

type ExportCustomer = {
  id: string;
  organization_id: string;
  seller_company_profile_id?: string | null;
  seller_company_profile_ids?: string[] | null;
  custom_fields?: unknown;
  price_list_type?: string | null;
  price_list_margin_percent?: number | string | null;
  currency?: string | null;
};

/** Revalidate customer pricing using the page transaction's DB connection. */
export async function resolvePortalPriceListExportContextFromDb({
  client, invite, brandId, brandName, customer,
}: {
  client: QueryClient;
  invite: ExportInvite;
  brandId: string;
  brandName: string;
  customer: ExportCustomer;
}) {
  const embedded = parseEmbeddedCustomerMeta(customer?.custom_fields);
  const primarySellerId = String(customer?.seller_company_profile_id || embedded.seller_company_profile_id || "").trim();
  const allowedSellerIds = new Set([
    primarySellerId,
    ...(Array.isArray(customer?.seller_company_profile_ids) ? customer.seller_company_profile_ids : []),
  ].map((id) => String(id || "").trim()).filter(Boolean));
  if (!invite || !customer || invite.organization_id !== customer.organization_id
    || invite.customer_id !== customer.id || invite.party_type !== "customer"
    || !["active", "invited"].includes(invite.status) || !invite.access_can_view_orders
    || (invite.allowed_brand_ids?.length && !invite.allowed_brand_ids.includes(brandId))
    || (invite.seller_company_profile_id && !allowedSellerIds.has(invite.seller_company_profile_id))) {
    throw new Error("EXPORT_SNAPSHOT_INVITE_DENIED");
  }
  const priceLists = (await client.query(
    `select list_type,margin_percent from public.customer_price_lists
     where organization_id=$1 and is_active=true and list_type in ('A','B')
     order by updated_at desc,created_at desc`,
    [invite.organization_id],
  )).rows;
  const pricing = deriveCustomerPriceListSettings(customer, priceLists);
  return {
    organizationId: invite.organization_id,
    inviteId: invite.id,
    customerId: customer.id,
    brandId,
    brandName,
    priceListType: pricing.customerType,
    currency: pricing.currency,
    effectiveMarginA: pricing.effectiveMarginA,
    effectiveMarginB: pricing.effectiveMarginB,
    cPriceListIds: pricing.cPriceListIds,
  };
}
