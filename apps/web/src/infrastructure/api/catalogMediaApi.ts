import type { ProductMediaItem } from "../../presentation/components/common/ProductVisual";

type CatalogMediaResponse = {
  ok?: boolean;
  items?: Array<{ src?: string; label?: string }>;
  error?: string;
};

export async function fetchCatalogProductMedia(input: {
  brand: string;
  code: string;
  imageUrl?: string | null;
}): Promise<ProductMediaItem[]> {
  const url = new URL("/api/catalog-product-media", window.location.origin);
  url.searchParams.set("brand", input.brand);
  url.searchParams.set("code", input.code);
  if (String(input.imageUrl || "").trim()) url.searchParams.set("image_url", String(input.imageUrl || "").trim());

  const response = await fetch(url.toString(), {
    method: "GET",
  });
  const data = (await response.json().catch(() => ({}))) as CatalogMediaResponse;
  if (!response.ok) {
    throw new Error(String(data.error || `Media request failed: ${response.status}`));
  }
  return (data.items || [])
    .map((item) => ({
      src: String(item?.src || "").trim(),
      label: String(item?.label || "").trim(),
    }))
    .filter((item) => item.src);
}
