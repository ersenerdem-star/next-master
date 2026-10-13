export type CurrentSupplierPriceRequest = {
  brand: string;
  productCode: string;
  supplierName: string;
};

export type CurrentSupplierPriceOption = {
  supplier_name: string | null;
  product_code: string | null;
  buy_price: number | string | null;
  price_date: string | null;
  notes: string | null;
};

export type CurrentSupplierPriceBatchRow = {
  request_index: number;
  has_published_scope: boolean;
  options: CurrentSupplierPriceOption[];
};

export type SelectedSupplierPrice = {
  buy_price: number;
  price_date: string | null;
  notes: string | null;
};

export function exactProductCode(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

export function currentSupplierPriceKey(request: CurrentSupplierPriceRequest): string {
  return JSON.stringify([
    request.brand.trim().toLowerCase(),
    exactProductCode(request.productCode),
    request.supplierName.trim().toLowerCase(),
  ]);
}

function requirePriceRequest(request: CurrentSupplierPriceRequest): void {
  if (!request.brand.trim() || !exactProductCode(request.productCode) || !request.supplierName.trim()) {
    throw new Error("A brand, exact product code, and selected supplier are required to refresh prices.");
  }
}

export async function fetchCurrentSupplierPriceMap(
  requests: CurrentSupplierPriceRequest[],
  fetchBatch: (items: Array<{ code: string; brand: string }>) => Promise<CurrentSupplierPriceBatchRow[]>,
): Promise<Map<string, SelectedSupplierPrice>> {
  const unique = new Map<string, CurrentSupplierPriceRequest>();
  for (const request of requests) {
    requirePriceRequest(request);
    unique.set(currentSupplierPriceKey(request), request);
  }

  const result = new Map<string, SelectedSupplierPrice>();
  const pending = [...unique.entries()];
  for (let offset = 0; offset < pending.length; offset += 25) {
    const batch = pending.slice(offset, offset + 25);
    const response = await fetchBatch(batch.map(([, request]) => ({ code: request.productCode, brand: request.brand })));
    if (!Array.isArray(response) || response.length !== batch.length) {
      throw new Error("Current supplier price lookup returned incomplete data.");
    }
    const byIndex = new Map<number, CurrentSupplierPriceBatchRow>();
    for (const row of response) {
      if (!Number.isInteger(row?.request_index) || row.request_index < 0 || row.request_index >= batch.length
          || byIndex.has(row.request_index) || typeof row.has_published_scope !== "boolean" || !Array.isArray(row.options)) {
        throw new Error("Current supplier price lookup returned invalid data.");
      }
      byIndex.set(row.request_index, row);
    }
    for (let index = 0; index < batch.length; index += 1) {
      const [key, request] = batch[index];
      const row = byIndex.get(index);
      if (!row) throw new Error("Current supplier price lookup omitted a line.");
      const matches = row.options.filter((option) =>
        exactProductCode(option?.product_code) === exactProductCode(request.productCode)
        && String(option?.supplier_name || "").trim().toLowerCase() === request.supplierName.trim().toLowerCase());
      const selected = matches
        .map((option) => ({ option, price: Number(option.buy_price) }))
        .filter(({ price }) => Number.isFinite(price) && price > 0)
        .sort((a, b) => a.price - b.price)[0];
      if (!selected) {
        const scope = row.has_published_scope ? "published" : "current";
        throw new Error(`No ${scope} price for ${request.brand} ${request.productCode} from ${request.supplierName}.`);
      }
      result.set(key, {
        buy_price: selected.price,
        price_date: String(selected.option.price_date || "").trim() || null,
        notes: String(selected.option.notes || "").trim() || null,
      });
    }
  }
  return result;
}
