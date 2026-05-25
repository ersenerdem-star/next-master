import { buildDiscontinuedWarning, normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { canonicalizeBrandName, normalizePartCode } from "../../domain/shared/normalize";
import type { QuoteResolveResult, QuoteSupplierOption } from "../../types/quoteBuilder";
import { supabaseClient } from "./supabaseClient";

async function enrichLifecycle(resolved: QuoteResolveResult): Promise<QuoteResolveResult> {
  if (!resolved.product_id) {
    const lifecycleStatus = normalizeCatalogLifecycleStatus(resolved.lifecycle_status);
    return {
      ...resolved,
      lifecycle_status: lifecycleStatus,
      lifecycle_note: resolved.lifecycle_note || null,
      lifecycle_warning:
        lifecycleStatus === "discontinued"
          ? buildDiscontinuedWarning({
              resolvedCode: resolved.product_code,
              note: resolved.lifecycle_note,
            })
          : null,
    };
  }

  try {
    const { data, error } = await supabaseClient
      .from("catalog_products")
      .select("lifecycle_status,lifecycle_note")
      .eq("id", resolved.product_id)
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    const lifecycleStatus = normalizeCatalogLifecycleStatus(String(data?.lifecycle_status || resolved.lifecycle_status || ""));
    const lifecycleNote = String(data?.lifecycle_note || resolved.lifecycle_note || "").trim() || null;

    return {
      ...resolved,
      lifecycle_status: lifecycleStatus,
      lifecycle_note: lifecycleNote,
      lifecycle_warning:
        lifecycleStatus === "discontinued"
          ? buildDiscontinuedWarning({
              resolvedCode: resolved.product_code,
              note: lifecycleNote,
            })
          : null,
    };
  } catch {
    const lifecycleStatus = normalizeCatalogLifecycleStatus(resolved.lifecycle_status);
    return {
      ...resolved,
      lifecycle_status: lifecycleStatus,
      lifecycle_note: resolved.lifecycle_note || null,
      lifecycle_warning:
        lifecycleStatus === "discontinued"
          ? buildDiscontinuedWarning({
              resolvedCode: resolved.product_code,
              note: resolved.lifecycle_note,
            })
          : null,
    };
  }
}

export async function resolveQuoteLine(input: {
  code: string;
  brand?: string;
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
  includeSupplierOptions?: boolean;
}): Promise<{ resolved: QuoteResolveResult; supplierOptions: QuoteSupplierOption[] }> {
  const code = normalizePartCode(input.code) || input.code.trim();
  const brand = canonicalizeBrandName(input.brand || "");
  const rpcCustomerType = input.customerType === "Other" ? "A" : input.customerType;
  const supplierRpcCustomerType = input.customerType === "B" ? "B" : "A";

  const { data, error } = await supabaseClient.rpc("cloud_resolve_quote_line", {
    input_code: code,
    input_brand: brand,
    input_customer_type: rpcCustomerType,
    input_margin_a: input.marginA / 100,
    input_margin_b: input.marginB / 100,
  });

  if (error) {
    throw new Error(error.message || "Quote resolve failed");
  }

  const resolved = await enrichLifecycle(((data || [])[0] || {
    found: false,
    product_code: code,
  }) as QuoteResolveResult);

  let supplierOptions: QuoteSupplierOption[] = [];
  const includeSupplierOptions = input.includeSupplierOptions !== false;

  if (resolved.found && includeSupplierOptions) {
    const optionsResult = await supabaseClient.rpc("cloud_quote_supplier_options", {
      input_code: code,
      input_brand: brand || resolved.brand || "",
      input_customer_type: supplierRpcCustomerType,
      input_margin_a: input.marginA / 100,
      input_margin_b: input.marginB / 100,
    });

    if (optionsResult.error) {
      throw new Error(optionsResult.error.message || "Supplier options load failed");
    }

    supplierOptions = ((optionsResult.data || []) as QuoteSupplierOption[]).map((option) => ({
      supplier_id: option.supplier_id || null,
      supplier_name: option.supplier_name || "",
      buy_price: option.buy_price ?? null,
      price_date: option.price_date || null,
      sell_price: option.sell_price ?? null,
      notes: option.notes || null,
    }));
  }

  const normalizedRequested = normalizePartCode(code);
  const normalizedResolved = normalizePartCode(resolved.product_code || code);
  const codeChanged = Boolean(normalizedRequested && normalizedResolved && normalizedRequested !== normalizedResolved);

  return {
    resolved: {
      ...resolved,
      product_code: resolved.product_code || code,
    },
    supplierOptions,
  };
}
