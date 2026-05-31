import { useEffect, useState } from "react";

import { resolveNamedLogo } from "./logoAssets";

export type ProductMediaItem = {
  src: string;
  label?: string;
};

type ProductVisualProps = {
  imageUrl?: string | null;
  imageGallery?: ProductMediaItem[];
  brand?: string | null;
  alt: string;
  detail?: boolean;
  onPreview?: ((item: ProductMediaItem | null) => void) | null;
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

export function ProductVisual({ imageUrl, imageGallery = [], brand, alt, detail = false, onPreview = null }: ProductVisualProps) {
  const displayBrand = String(brand || "").trim();
  const monogram = buildBrandMonogram(displayBrand || alt);
  const logoAsset = resolveNamedLogo(displayBrand);
  const [imageFailed, setImageFailed] = useState(false);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const resolvedImageUrl = String(imageUrl || "").trim();
  const normalizedGallery = imageGallery
    .map((item) => ({
      src: String(item?.src || "").trim(),
      label: String(item?.label || "").trim(),
    }))
    .filter((item) => item.src && !isKnownPlaceholderImageUrl(item.src));
  const galleryItems = normalizedGallery.length
    ? normalizedGallery
    : resolvedImageUrl && !isKnownPlaceholderImageUrl(resolvedImageUrl)
      ? [{ src: resolvedImageUrl, label: "" }]
      : [];
  const activeGalleryItem = galleryItems[Math.min(activeImageIndex, Math.max(galleryItems.length - 1, 0))] || null;
  const shouldUseFallback = !activeGalleryItem?.src || imageFailed;

  useEffect(() => {
    setImageFailed(false);
    setActiveImageIndex(0);
  }, [resolvedImageUrl, JSON.stringify(galleryItems.map((item) => item.src))]);

  if (!shouldUseFallback) {
    const imageElement = (
      <img
        src={activeGalleryItem.src}
        alt={alt}
        className={`catalog-thumb${detail ? " catalog-thumb--detail" : ""}`}
        loading="lazy"
        onError={() => setImageFailed(true)}
      />
    );
    const mediaElement = onPreview ? (
      <button
        type="button"
        className={`catalog-thumb-button${detail ? " catalog-thumb-button--detail" : ""}`}
        onClick={() => onPreview(activeGalleryItem)}
      >
        {imageElement}
      </button>
    ) : (
      imageElement
    );

    if (detail && galleryItems.length > 1) {
      return (
        <div className="catalog-media-carousel">
          {mediaElement}
          <div className="catalog-media-carousel__toolbar">
            <button
              type="button"
              className="catalog-media-carousel__nav"
              onClick={() => setActiveImageIndex((current) => (current <= 0 ? galleryItems.length - 1 : current - 1))}
              aria-label="Previous image"
            >
              ‹
            </button>
            <span className="catalog-media-carousel__caption">{activeGalleryItem.label || `Image ${activeImageIndex + 1}`}</span>
            <button
              type="button"
              className="catalog-media-carousel__nav"
              onClick={() => setActiveImageIndex((current) => (current >= galleryItems.length - 1 ? 0 : current + 1))}
              aria-label="Next image"
            >
              ›
            </button>
          </div>
          <div className="catalog-media-carousel__thumbs">
            {galleryItems.map((item, index) => (
              <button
                key={`${item.src}::${index}`}
                type="button"
                className={`catalog-media-carousel__thumb${index === activeImageIndex ? " active" : ""}`}
                onClick={() => setActiveImageIndex(index)}
              >
                {item.label || `Image ${index + 1}`}
              </button>
            ))}
          </div>
        </div>
      );
    }

    return mediaElement;
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
