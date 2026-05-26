type BrandPillProps = {
  brand?: string | null;
  compact?: boolean;
  className?: string;
};

export function BrandPill({ brand, compact = false, className = "" }: BrandPillProps) {
  const value = String(brand || "").trim();
  if (!value) return <span>-</span>;

  return (
    <span
      className={`brand-pill${compact ? " brand-pill--compact" : ""}${className ? ` ${className}` : ""}`}
      title={value}
    >
      {value}
    </span>
  );
}
