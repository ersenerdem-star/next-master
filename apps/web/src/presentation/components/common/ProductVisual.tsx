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

export function ProductVisual({ imageUrl, brand, alt, detail = false, onPreview = null }: ProductVisualProps) {
  const displayBrand = String(brand || "").trim();
  const monogram = buildBrandMonogram(displayBrand || alt);
  const logoAsset = resolveNamedLogo(displayBrand);

  if (imageUrl) {
    const image = <img src={imageUrl} alt={alt} className={`catalog-thumb${detail ? " catalog-thumb--detail" : ""}`} loading="lazy" />;
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
