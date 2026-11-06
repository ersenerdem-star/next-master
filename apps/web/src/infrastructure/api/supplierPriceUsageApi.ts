import { supabaseClient } from './supabaseClient';

export type SupplierPriceUsage = { id: string; name: string; price_usage_enabled: boolean };
export type SupplierPriceUsageReceipt = { supplier_id: string; price_usage_enabled: boolean; changed: boolean };

async function request(body?: { supplierId: string; enabled: boolean; expectedEnabled: boolean; reason: string }) {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('SUPPLIER_PRICE_USAGE_FORBIDDEN');
  const response = await fetch('/api/supplier-price-usage', {
    method: body ? 'POST' : 'GET', cache: 'no-store', redirect: 'error',
    headers: { Authorization: `Bearer ${data.session.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(body ? 130_000 : 20_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || 'SUPPLIER_PRICE_USAGE_UNAVAILABLE');
  return result;
}

export async function fetchSupplierPriceUsage(): Promise<SupplierPriceUsage[]> {
  const result = await request();
  if (!Array.isArray(result.suppliers) || result.suppliers.some((s: SupplierPriceUsage) => typeof s.id !== 'string' || typeof s.price_usage_enabled !== 'boolean'))
    throw new Error('SUPPLIER_PRICE_USAGE_UNAVAILABLE');
  return result.suppliers;
}

export async function setSupplierPriceUsage(input: { supplierId: string; enabled: boolean; expectedEnabled: boolean; reason: string }): Promise<SupplierPriceUsageReceipt> {
  const result = await request(input);
  if (result.supplier_id !== input.supplierId || result.price_usage_enabled !== input.enabled || typeof result.changed !== 'boolean')
    throw new Error('SUPPLIER_PRICE_USAGE_UNAVAILABLE');
  return result;
}
