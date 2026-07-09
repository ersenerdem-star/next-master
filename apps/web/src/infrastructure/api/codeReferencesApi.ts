import { canonicalizeBrandName, includesLooseText, normalizeBrandKey, normalizeBrandName, normalizePartCode } from "../../domain/shared/normalize";
import type { CodeReferenceMatch, CodeReferenceRow, CodeReferenceUsage } from "../../types/codeReferences";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

async function withTimeout<T>(promiseLike: PromiseLike<T> | T, label: string, timeoutMs = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(promiseLike as PromiseLike<T>), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function chunkArray<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function mapCodeReferenceError(message: string) {
  if (message.includes("item_code_references_organization_id_brand_id_normalized_ol_key")) {
    return "This old customer code already has a mapping for this brand. Edit the existing reference instead of creating a duplicate.";
  }
  return sanitizeUserFacingMessage(message, "Code reference request failed");
}

async function resolveBrandRow(brandName: string) {
  const organizationId = await getCurrentOrgId();
  const requestedBrandName = normalizeBrandName(brandName);
  const requestedBrandKey = normalizeBrandKey(requestedBrandName);
  const { data, error } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId);

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Brand lookup failed"));
  const match = ((data || []) as Array<{ id: string; name: string }>).find((row) => normalizeBrandKey(normalizeBrandName(String(row.name || ""))) === requestedBrandKey);
  if (!match?.id) throw new Error(`Brand not found: ${requestedBrandName || brandName}`);
  return { id: match.id as string, name: match.name as string };
}

async function resolveOrCreateBrandRow(brandName: string) {
  const trimmed = normalizeBrandName(brandName);
  if (!trimmed) throw new Error("Brand is required");

  const existing = await resolveBrandRow(trimmed).catch(() => null);
  if (existing) return existing;

  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("brands")
    .insert({
      organization_id: organizationId,
      name: trimmed,
    })
    .select("id,name")
    .single();

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, `Failed to create brand: ${trimmed}`));
  if (!data?.id) throw new Error(`Brand could not be created: ${trimmed}`);
  return { id: data.id as string, name: (data.name as string) || trimmed };
}

export async function fetchCodeReferences(search = ""): Promise<CodeReferenceRow[]> {
  const searchTerm = search.trim();
  const { data, error } = await withTimeout(
    supabaseClient
      .from("item_code_references")
      .select("id,brand_id,old_code,new_code,original_number,reason,is_active,created_at,updated_at,brands!inner(name)")
      .order("updated_at", { ascending: false })
      .limit(200),
    "Code references load",
  );

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Code references load failed"));

  let rows = (data || []).map((row) => ({
    id: row.id as string,
    brand_id: row.brand_id as string,
    brand: ((row.brands as { name?: string } | null)?.name || "") as string,
    old_code: row.old_code as string,
    new_code: row.new_code as string,
    original_number: (row.original_number as string | null) || "",
    reason: (row.reason as string | null) || "",
    is_active: Boolean(row.is_active),
    created_at: (row.created_at as string | null) || null,
    updated_at: (row.updated_at as string | null) || null,
  }));

  if (searchTerm) {
    const normalized = normalizePartCode(searchTerm);
    rows = rows.filter((row) => {
      return (
        includesLooseText(row.brand, searchTerm) ||
        normalizePartCode(row.old_code).includes(normalized) ||
        normalizePartCode(row.new_code).includes(normalized) ||
        normalizePartCode(row.original_number || "").includes(normalized) ||
        includesLooseText(row.reason || "", searchTerm)
      );
    });
  }

  return rows;
}

export async function createCodeReference(input: {
  brand: string;
  old_code: string;
  new_code: string;
  original_number: string | null;
  reason: string | null;
}): Promise<CodeReferenceRow> {
  const organizationId = await getCurrentOrgId();
  const brandRow = await resolveOrCreateBrandRow(input.brand);
  const { data, error } = await withTimeout(
    supabaseClient
      .from("item_code_references")
      .insert({
        organization_id: organizationId,
        brand_id: brandRow.id,
        old_code: input.old_code,
        new_code: input.new_code,
        original_number: input.original_number,
        reason: input.reason,
        is_active: true,
      })
      .select("id,brand_id,old_code,new_code,original_number,reason,is_active,created_at,updated_at")
      .single(),
    "Code reference create",
  );
  if (error) throw new Error(mapCodeReferenceError(error.message || "Code reference create failed"));

  return {
    id: data.id as string,
    brand_id: data.brand_id as string,
    brand: brandRow.name,
    old_code: data.old_code as string,
    new_code: data.new_code as string,
    original_number: (data.original_number as string | null) || "",
    reason: (data.reason as string | null) || "",
    is_active: Boolean(data.is_active),
    created_at: (data.created_at as string | null) || null,
    updated_at: (data.updated_at as string | null) || null,
  };
}

export async function updateCodeReference(
  id: string,
  input: {
    brand: string;
    old_code: string;
    new_code: string;
    original_number: string | null;
    reason: string | null;
    is_active: boolean;
  },
) {
  const brandRow = await resolveBrandRow(input.brand);
  const { error } = await withTimeout(
    supabaseClient
      .from("item_code_references")
      .update({
        brand_id: brandRow.id,
        old_code: input.old_code,
        new_code: input.new_code,
        original_number: input.original_number,
        reason: input.reason,
        is_active: input.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id),
    "Code reference update",
  );
  if (error) throw new Error(mapCodeReferenceError(error.message || "Code reference update failed"));
}

export async function deleteCodeReference(id: string) {
  const { error } = await withTimeout(supabaseClient.from("item_code_references").delete().eq("id", id), "Code reference delete");
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Code reference delete failed"));
}

export async function importCodeReferences(
  rows: Array<{
    brand: string;
    old_code: string;
    new_code: string;
    original_number: string | null;
    reason: string | null;
    is_active: boolean;
  }>,
) {
  const organizationId = await getCurrentOrgId();
  const uniqueBrands = [...new Set(rows.map((row) => row.brand.trim()).filter(Boolean))];
  const brandMap = new Map<string, string>();

  for (const brandName of uniqueBrands) {
    const row = await resolveOrCreateBrandRow(brandName);
    brandMap.set(normalizeBrandKey(brandName), row.id);
  }

  const preparedRows = rows
    .filter((row) => row.brand.trim() && row.old_code.trim() && row.new_code.trim())
    .map((row) => ({
      organization_id: organizationId,
      brand_id: brandMap.get(normalizeBrandKey(row.brand)) || "",
      old_code: row.old_code.trim(),
      new_code: row.new_code.trim(),
      original_number: row.original_number?.trim() || null,
      reason: row.reason?.trim() || null,
      is_active: row.is_active,
      updated_at: new Date().toISOString(),
    }))
    .filter((row) => row.brand_id);

  const dedupedPayload = new Map<string, (typeof preparedRows)[number]>();
  for (const row of preparedRows) {
    const key = `${row.organization_id}:${row.brand_id}:${normalizePartCode(row.old_code)}`;
    const current = dedupedPayload.get(key);
    dedupedPayload.set(key, {
      ...(current || row),
      ...row,
      original_number: row.original_number ?? current?.original_number ?? null,
      reason: row.reason ?? current?.reason ?? null,
    });
  }

  const payload = Array.from(dedupedPayload.values());

  if (!payload.length) {
    throw new Error("No valid code reference rows found in CSV");
  }

  const { error } = await withTimeout(
    supabaseClient.from("item_code_references").upsert(payload, {
      onConflict: "organization_id,brand_id,normalized_old_code",
    }),
    "Code reference import",
  );

  if (error) throw new Error(mapCodeReferenceError(error.message || "Code reference import failed"));
}

export async function findCodeReferenceMatch(input: { code: string; brand?: string }): Promise<CodeReferenceMatch | null> {
  const normalized = normalizePartCode(input.code);
  if (!normalized) return null;

  let query = supabaseClient
    .from("item_code_references")
    .select("id,brand_id,old_code,new_code,original_number,reason,brands!inner(name)")
    .eq("is_active", true)
    .eq("normalized_old_code", normalized)
    .limit(input.brand?.trim() ? 1 : 2);

  if (input.brand?.trim()) {
    const brandRow = await resolveBrandRow(input.brand);
    query = query.eq("brand_id", brandRow.id);
  }

  const { data, error } = await withTimeout(query, "Code reference lookup");
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Code reference lookup failed"));
  const rows = (data || []) as Array<{
    id: string;
    brand_id: string;
    old_code: string;
    new_code: string;
    original_number: string | null;
    reason: string | null;
    brands?: { name?: string } | null;
  }>;

  if (!rows.length) return null;
  if (!input.brand?.trim() && rows.length > 1) return null;

  const match = rows[0];
  return {
    id: match.id,
    brand_id: match.brand_id,
    brand: match.brands?.name || "",
    old_code: match.old_code,
    new_code: match.new_code,
    original_number: match.original_number || null,
    reason: match.reason || null,
  };
}

function matchRowKey(brand: string, normalizedCode: string) {
  return `${normalizeBrandKey(brand)}::${normalizedCode}`;
}

export async function fetchCodeReferenceMatchesForRows(
  rows: Array<{ code: string; brand?: string | null }>,
): Promise<Map<string, CodeReferenceMatch>> {
  const candidates = rows
    .map((row) => ({
      brand: canonicalizeBrandName(String(row.brand || "")),
      normalized_code: normalizePartCode(String(row.code || "")),
    }))
    .filter((row) => row.brand && row.normalized_code);

  if (!candidates.length) return new Map<string, CodeReferenceMatch>();

  const brandKeys = [...new Set(candidates.map((row) => normalizeBrandKey(row.brand)))];
  const normalizedCodes = [...new Set(candidates.map((row) => row.normalized_code))];
  const organizationId = await getCurrentOrgId();

  const { data: brandRows, error: brandError } = await withTimeout(
    supabaseClient.from("brands").select("id,name").eq("organization_id", organizationId),
    "Code reference brand batch lookup",
  );

  if (brandError) throw new Error(sanitizeUserFacingMessage(brandError.message, "Code reference brand batch lookup failed"));

  const brandIdToName = new Map<string, string>();
  const brandIds = (brandRows || [])
    .filter((row) => brandKeys.includes(normalizeBrandKey(String(row.name || ""))))
    .map((row) => {
      const id = String(row.id);
      brandIdToName.set(id, String(row.name || ""));
      return id;
    });

  if (!brandIds.length) return new Map<string, CodeReferenceMatch>();

  const { data, error } = await withTimeout(
    supabaseClient
      .from("item_code_references")
      .select("id,brand_id,old_code,new_code,original_number,reason")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .in("brand_id", brandIds)
      .in("normalized_old_code", normalizedCodes),
    "Code reference batch lookup",
  );

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Code reference batch lookup failed"));

  const result = new Map<string, CodeReferenceMatch>();
  for (const row of (data || []) as Array<{
    id: string;
    brand_id: string;
    old_code: string;
    new_code: string;
    original_number: string | null;
    reason: string | null;
  }>) {
    const brandName = brandIdToName.get(String(row.brand_id)) || "";
    const normalizedOldCode = normalizePartCode(String(row.old_code || ""));
    if (!brandName || !normalizedOldCode) continue;
    result.set(matchRowKey(brandName, normalizedOldCode), {
      id: String(row.id),
      brand_id: String(row.brand_id),
      brand: brandName,
      old_code: String(row.old_code || ""),
      new_code: String(row.new_code || ""),
      original_number: row.original_number || null,
      reason: row.reason || null,
    });
  }

  return result;
}

export async function fetchCatalogReferenceCoverage(
  rows: Array<{ brand: string; product_code: string }>,
): Promise<Record<string, number>> {
  const candidates = rows
    .map((row) => ({
      brand: canonicalizeBrandName(row.brand),
      normalized_code: normalizePartCode(row.product_code),
    }))
    .filter((row) => row.brand && row.normalized_code);

  if (!candidates.length) return {};

  const uniqueBrands = [...new Set(candidates.map((row) => normalizeBrandKey(row.brand)))];
  const brandRows = [];
  for (const brandName of uniqueBrands) {
    const row = await resolveBrandRow(brandName);
    brandRows.push(row);
  }

  const brandIdByName = new Map<string, string>(brandRows.map((row) => [normalizeBrandKey(row.name), row.id]));
  const brandIds = [...new Set(brandRows.map((row) => row.id))];
  const normalizedCodes = [...new Set(candidates.map((row) => row.normalized_code))];

  const { data, error } = await withTimeout(
    supabaseClient
      .from("item_code_references")
      .select("brand_id,new_code")
      .eq("is_active", true)
      .in("brand_id", brandIds)
      .in("normalized_new_code", normalizedCodes),
    "Code reference coverage load",
  );

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Code reference coverage load failed"));

  const reverseBrandMap = new Map<string, string>();
  for (const [name, id] of brandIdByName.entries()) reverseBrandMap.set(id, name);

  const counts: Record<string, number> = {};
  for (const row of (data || []) as Array<{ brand_id: string; new_code: string }>) {
    const brandName = normalizeBrandKey(reverseBrandMap.get(row.brand_id) || "");
    const normalizedCode = normalizePartCode(row.new_code);
    if (!brandName || !normalizedCode) continue;
    const key = `${brandName}::${normalizedCode}`;
    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

export async function inspectCodeReferenceUsage(input: { brand: string; code: string }): Promise<CodeReferenceUsage | null> {
  const brand = input.brand.trim();
  const normalized = normalizePartCode(input.code);
  if (!brand || !normalized) return null;

  const brandRow = await resolveBrandRow(brand);
  const { data, error } = await withTimeout(
    supabaseClient
      .from("item_code_references")
      .select("id,old_code,new_code")
      .eq("brand_id", brandRow.id)
      .or(`normalized_old_code.eq.${normalized},normalized_new_code.eq.${normalized}`)
      .limit(20),
    "Code reference usage check",
  );

  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Code reference usage check failed"));
  const rows = (data || []) as Array<{ id: string; old_code: string; new_code: string }>;
  if (!rows.length) return null;

  return {
    code: input.code.trim(),
    matchesOldCode: rows.filter((row) => normalizePartCode(row.old_code) === normalized),
    matchesNewCode: rows.filter((row) => normalizePartCode(row.new_code) === normalized),
  };
}

export async function fetchOldCodesByNewCodeForBrand(input: {
  brand: string;
  newCodes: string[];
}): Promise<Record<string, string[]>> {
  const brand = input.brand.trim();
  const normalizedCodes = [...new Set(input.newCodes.map((code) => normalizePartCode(code)).filter(Boolean))];
  if (!brand || !normalizedCodes.length) return {};

  const brandRow = await resolveBrandRow(brand);
  const output: Record<string, string[]> = {};

  for (const codeChunk of chunkArray(normalizedCodes, 250)) {
    const { data, error } = await withTimeout(
      supabaseClient
        .from("item_code_references")
        .select("old_code,new_code")
        .eq("brand_id", brandRow.id)
        .eq("is_active", true)
        .in("normalized_new_code", codeChunk),
      "Old code coverage load",
    );

    if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Old code coverage load failed"));

    for (const row of (data || []) as Array<{ old_code: string; new_code: string }>) {
      const normalizedNewCode = normalizePartCode(row.new_code);
      if (!normalizedNewCode) continue;
      if (!output[normalizedNewCode]) output[normalizedNewCode] = [];
      output[normalizedNewCode].push(row.old_code);
    }
  }

  return output;
}
