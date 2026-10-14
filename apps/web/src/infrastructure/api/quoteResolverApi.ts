import { buildDiscontinuedWarning, normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { canonicalizeBrandName, normalizePartCode } from "../../domain/shared/normalize";
import type { QuoteResolveResult, QuoteSupplierOption } from "../../types/quoteBuilder";
import { callAppRpc } from "./appRpcApi";
import { supabaseClient } from "./supabaseClient";

import { readSupplierCommercialTerms } from "../../domain/shared/supplierCommercialTerms";

function exactSku(value: string | null | undefined) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

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
  // Preserve the supplier's SKU punctuation. `61/1` and `611` can carry
  // different prices even though the legacy loose lookup maps both to `611`.
  const code = input.code.trim();
  const brand = canonicalizeBrandName(input.brand || "");
  const rpcCustomerType = input.customerType === "Other" ? "A" : input.customerType;
  const supplierRpcCustomerType = input.customerType === "B" ? "B" : "A";

  const data = await callAppRpc<QuoteResolveResult[]>("cloud_resolve_quote_line_v3", {
    input_code: code,
    input_brand: brand,
    input_customer_type: rpcCustomerType,
    input_margin_a: input.marginA / 100,
    input_margin_b: input.marginB / 100,
  });

  const rawResolved = ((data || [])[0] || {
    found: false,
    product_code: code,
  }) as QuoteResolveResult;
  // The caller applies an approved old-code reference before this lookup.
  // A price lookup itself may never replace 61/1 with the distinct SKU 611.
  if (rawResolved.found && exactSku(rawResolved.product_code) !== exactSku(code)) {
    throw new Error(`Supplier price lookup returned a different product code for ${brand} ${code}.`);
  }
  const resolved = await enrichLifecycle(rawResolved);

  let supplierOptions: QuoteSupplierOption[] = [];
  const includeSupplierOptions = input.includeSupplierOptions !== false;

  if (resolved.found && includeSupplierOptions) {
    const optionRows = await callAppRpc<QuoteSupplierOption[]>("cloud_quote_supplier_commercial_options_v3", {
      input_code: code,
      input_brand: brand || resolved.brand || "",
      input_customer_type: supplierRpcCustomerType,
      input_margin_a: input.marginA / 100,
      input_margin_b: input.marginB / 100,
    });
    supplierOptions = (optionRows || []).map((option) => {
      if (!String(option.supplier_id || "").trim()) throw new Error("Supplier commercial rules could not be verified.");
      return {
        ...readSupplierCommercialTerms(option),
        supplier_id: option.supplier_id || null,
        supplier_name: option.supplier_name || "",
        buy_price: option.buy_price ?? null,
        price_date: option.price_date || null,
        sell_price: option.sell_price ?? null,
        notes: option.notes || null,
      };
    });
  }

  const normalizedRequested = normalizePartCode(code);
  const normalizedResolved = normalizePartCode(resolved.product_code || code);
  const codeChanged = Boolean(normalizedRequested && normalizedResolved && normalizedRequested !== normalizedResolved);

  return {
    resolved: {
      ...resolved,
      product_code: resolved.product_code || code,
      ...(includeSupplierOptions && resolved.found ? {
        supplier_id: supplierOptions[0]?.supplier_id ?? null, supplier_name: supplierOptions[0]?.supplier_name ?? null,
        buy_price: supplierOptions[0]?.buy_price ?? null, sell_price: supplierOptions[0]?.sell_price ?? null,
        price_date: supplierOptions[0]?.price_date ?? null, notes: supplierOptions[0]?.notes ?? null,
        moq: supplierOptions[0]?.moq ?? null, order_multiple: supplierOptions[0]?.order_multiple ?? null,
      } : {}),
    },
    supplierOptions,
  };
}
