import { callAppRpc } from "./appRpcApi";

export type SalesBrandFilters = { organizationId: string; from: string; to: string; customer: string; customerName: string; status: string; brand: string };
export type SalesBrandSummary = { brand: string; currency: string; order_count: number; line_count: number; detail_count: number; content_hash: string; missing_price_count: number; missing_quantity_count: number; quantity: number | null; amount: number | null };
export type SalesBrandDetail = { order_id: string; order_no: string; order_date: string; customer_id: string | null; customer_name: string; status: string; brand: string; requested_code: string; product_code: string; description: string; quantity: number | null; unit_price: number | null; amount: number | null; currency: string; line_index: number };

function args(f: SalesBrandFilters) {
  return { input_org: f.organizationId, input_from: f.from || null, input_to: f.to || null, input_customer: f.customer || null, input_customer_name: f.customerName || null, input_status: f.status || null, input_brand: f.brand || null };
}
async function rows<T>(name: string, params: Record<string, unknown>): Promise<T[]> {
  const result = await callAppRpc<unknown>(name, params);
  if (!Array.isArray(result)) throw new Error("Rapor yanıtı eksik. Lütfen tekrar deneyin.");
  return result as T[];
}
export async function fetchSalesBrandSummary(filters: SalesBrandFilters) {
  const result: SalesBrandSummary[] = [];
  for (let offset = 0; offset < 100_000; offset += 500) {
    const page = await rows<SalesBrandSummary>("reporting_sales_orders_brand_summary", { ...args(filters), input_offset: offset, input_limit: 500 });
    result.push(...page);
    if (page.length < 500) return result;
  }
  throw new Error("Rapor özeti tamamlanamadı. Lütfen filtreleri daraltın.");
}
export const fetchSalesBrandDetails = (filters: SalesBrandFilters, offset: number, limit: number) => rows<SalesBrandDetail>("reporting_sales_orders_brand_details", { ...args(filters), input_offset: offset, input_limit: limit });

export type SalesBrandCustomer = { customer_id: string | null; customer_name: string };
export async function fetchSalesBrandCustomers(organizationId: string) {
  const result: SalesBrandCustomer[] = [];
  for (let offset = 0; offset < 100_000; offset += 500) {
    const page = await rows<SalesBrandCustomer>("reporting_sales_orders_brand_customers", { input_org: organizationId, input_offset: offset, input_limit: 500 });
    result.push(...page);
    if (page.length < 500) return result;
  }
  throw new Error("Müşteri listesi tamamlanamadı. Lütfen tekrar deneyin.");
}
