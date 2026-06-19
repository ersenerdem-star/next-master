import { resolveNamedLogo } from "./logoAssets";

type BrandPillProps = {
  brand?: string | null;
  compact?: boolean;
  className?: string;
  withLogo?: boolean;
};

export function BrandPill({ brand, compact = false, className = "", withLogo = false }: BrandPillProps) {
  const value = String(brand || "").trim();
  if (!value) return <span>-</span>;
  const logo = withLogo ? resolveNamedLogo(value) : null;

  return (
    <span
      className={`brand-pill${compact ? " brand-pill--compact" : ""}${logo ? " brand-pill--with-logo" : ""}${className ? ` ${className}` : ""}`}
      title={value}
    >
      {logo ? <img src={logo.src} alt="" className="brand-pill__logo" loading="lazy" /> : null}
      <span className="brand-pill__label">{value}</span>
    </span>
  );
}
