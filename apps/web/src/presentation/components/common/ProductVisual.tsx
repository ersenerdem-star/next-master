import { useEffect, useState } from "react";

import { resolveNamedLogo } from "./logoAssets";

type ProductVisualProps = {
  imageUrl?: string | null;
  brand?: string | null;
  alt: string;
  detail?: boolean;
  onPreview?: (() => void) | null;
};

function buildBrandMonogram(value: string) {
  const tokens = String(value || "")
    .trim()
    .split(/[\s/-]+/g)
    .filter(Boolean);
  if (!tokens.length) return "PR";
  if (tokens.length === 1) return tokens[0].slice(0, 3).toUpperCase();
  return tokens
    .slice(0, 2)
    .map((token) => token[0]?.toUpperCase() || "")
    .join("");
}

function isKnownPlaceholderImageUrl(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  return [
    "placeholder-image",
    "placeholder",
    "image-not-available",
    "no-image",
    "noimage",
    "not-available",
    "camera.svg",
    "camera-icon",
    "icon-camera",
    "coming-soon",
    "coming_soon",
    "imagecomingsoon",
    "default-image",
  ].some((token) => normalized.includes(token));
}

export function ProductVisual({ imageUrl, brand, alt, detail = false, onPreview = null }: ProductVisualProps) {
  const displayBrand = String(brand || "").trim();
  const monogram = buildBrandMonogram(displayBrand || alt);
  const logoAsset = resolveNamedLogo(displayBrand);
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedImageUrl = String(imageUrl || "").trim();
  const shouldUseFallback = !resolvedImageUrl || isKnownPlaceholderImageUrl(resolvedImageUrl) || imageFailed;

  useEffect(() => {
    setImageFailed(false);
  }, [resolvedImageUrl]);

  if (!shouldUseFallback) {
    const image = (
      <img
        src={resolvedImageUrl}
        alt={alt}
        className={`catalog-thumb${detail ? " catalog-thumb--detail" : ""}`}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    );
    if (onPreview) {
      return (
        <button type="button" className={`catalog-thumb-button${detail ? " catalog-thumb-button--detail" : ""}`} onClick={onPreview}>
          {image}
        </button>
      );
    }
    return image;
  }

  return (
    <div
      className={`catalog-thumb-fallback${detail ? " catalog-thumb-fallback--detail" : ""}`}
      title={displayBrand || alt}
      aria-label={displayBrand ? `${displayBrand} brand fallback` : `${alt} fallback`}
    >
      {logoAsset ? <img src={logoAsset.src} alt="" className="catalog-thumb-fallback__logo" /> : <span className="catalog-thumb-fallback__mono">{monogram}</span>}
    </div>
  );
}
