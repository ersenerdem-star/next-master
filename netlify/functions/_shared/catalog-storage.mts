import { buildRestUrl, getJson, sendJson, serviceRoleHeaders } from "./http.mts";

export type CatalogStorageSource = {
  id: string;
  organization_id?: string | null;
  storage_bucket: string;
  storage_object_path: string;
  storage_object_id?: string | null;
};

function storageObjectUrl(supabaseUrl: string, bucket: string, objectPath: string) {
  const encodedPath = String(objectPath || "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`, supabaseUrl).toString();
}

export async function deleteCatalogStorageObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  source: Pick<CatalogStorageSource, "storage_bucket" | "storage_object_path">,
) {
  const response = await fetch(storageObjectUrl(supabaseUrl, source.storage_bucket, source.storage_object_path), {
    method: "DELETE",
    // Storage's DELETE endpoint rejects an empty request body when a JSON
    // content type is present. Keep the auth headers, but omit Content-Type.
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => "");
    throw new Error(`CATALOG_STORAGE_DELETE_HTTP_${response.status}:${body.slice(0, 300)}`);
  }
  return { deleted: true, status: response.status };
}

export async function cleanupCatalogStorageSource(
  supabaseUrl: string,
  serviceRoleKey: string,
  source: CatalogStorageSource,
) {
  const result = await deleteCatalogStorageObject(supabaseUrl, serviceRoleKey, source);
  await sendJson<unknown>(buildRestUrl(supabaseUrl, "catalog_import_sources", { id: `eq.${source.id}` }), {
    method: "PATCH",
    headers: { ...serviceRoleHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify({ storage_object_id: null, updated_at: new Date().toISOString() }),
    timeoutMs: 12_000,
  });
  return result;
}

export async function cleanupCompletedCatalogStorageSources(
  supabaseUrl: string,
  serviceRoleKey: string,
  limit = 25,
) {
  const url = buildRestUrl(supabaseUrl, "catalog_import_sources", {
    select: "id,organization_id,storage_bucket,storage_object_path,storage_object_id",
    status: "eq.completed",
    storage_object_id: "not.is.null",
    order: "completed_at.asc.nullsfirst",
    limit: String(Math.max(1, Math.min(limit, 100))),
  });
  const sources = await getJson<CatalogStorageSource[]>(url, {
    headers: serviceRoleHeaders(serviceRoleKey),
    timeoutMs: 12_000,
  });
  let cleaned = 0;
  for (const source of sources || []) {
    try {
      await cleanupCatalogStorageSource(supabaseUrl, serviceRoleKey, source);
      cleaned += 1;
    } catch (error) {
      console.error("catalog storage cleanup deferred", source.id, error);
    }
  }
  return { scanned: sources?.length || 0, cleaned };
}
