import { resolveNamedLogo } from "./logoAssets";

type BrandPillProps = {
  brand?: string | null;
  compact?: boolean;
  className?: string;
  withLogo?: boolean;
  logoOnly?: boolean;
};

export function BrandPill({ brand, compact = false, className = "", withLogo = false, logoOnly = false }: BrandPillProps) {
  const value = String(brand || "").trim();
  if (!value) return <span>-</span>;
  const logo = withLogo || logoOnly ? resolveNamedLogo(value) : null;
  const showLabel = !logoOnly || !logo;

  return (
    <span
      className={`brand-pill${compact ? " brand-pill--compact" : ""}${logo ? " brand-pill--with-logo" : ""}${logoOnly && logo ? " brand-pill--logo-only" : ""}${className ? ` ${className}` : ""}`}
      title={value}
    >
      {logo ? <img src={logo.src} alt="" className="brand-pill__logo" loading="lazy" /> : null}
      {showLabel ? <span className="brand-pill__label">{value}</span> : null}
    </span>
  );
}
