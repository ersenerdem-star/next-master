import { useMemo, useState } from "react";

type VehicleBadgeMeta = {
  label: string;
  mark: string;
  tone: string;
};

type VehicleBadgesProps = {
  value?: string | null;
  compact?: boolean;
  limit?: number;
  expandable?: boolean;
  className?: string;
};

const VEHICLE_META: Array<{ match: RegExp; label: string; mark: string; tone: string }> = [
  { match: /mercedes|benz/i, label: "Mercedes-Benz", mark: "MB", tone: "mercedes" },
  { match: /\bman\b/i, label: "MAN", mark: "MAN", tone: "man" },
  { match: /volvo/i, label: "Volvo", mark: "VO", tone: "volvo" },
  { match: /\bdaf\b/i, label: "DAF", mark: "DAF", tone: "daf" },
  { match: /scania/i, label: "Scania", mark: "SC", tone: "scania" },
  { match: /volkswagen|vw/i, label: "Volkswagen", mark: "VW", tone: "volkswagen" },
  { match: /\baudi\b/i, label: "Audi", mark: "AU", tone: "audi" },
  { match: /\bford\b/i, label: "Ford", mark: "FO", tone: "ford" },
  { match: /\bnissan\b/i, label: "Nissan", mark: "NI", tone: "nissan" },
  { match: /renault/i, label: "Renault", mark: "RE", tone: "renault" },
  { match: /\biveco\b/i, label: "Iveco", mark: "IV", tone: "iveco" },
  { match: /toyota/i, label: "Toyota", mark: "TY", tone: "toyota" },
  { match: /opel/i, label: "Opel", mark: "OP", tone: "opel" },
  { match: /peugeot/i, label: "Peugeot", mark: "PE", tone: "peugeot" },
  { match: /citroen/i, label: "Citroen", mark: "CI", tone: "citroen" },
  { match: /bmw/i, label: "BMW", mark: "BMW", tone: "bmw" },
];

function buildVehicleMark(value: string) {
  const tokens = value
    .replace(/[()]/g, " ")
    .split(/[\s/-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  if (!tokens.length) return "VH";
  if (tokens.length === 1) return tokens[0].slice(0, 3).toUpperCase();
  return tokens
    .slice(0, 2)
    .map((token) => token[0]?.toUpperCase() || "")
    .join("");
}

function resolveVehicleMeta(value: string): VehicleBadgeMeta {
  const cleaned = value.trim();
  const matched = VEHICLE_META.find((entry) => entry.match.test(cleaned));
  if (matched) {
    return {
      label: matched.label,
      mark: matched.mark,
      tone: matched.tone,
    };
  }
  return {
    label: cleaned,
    mark: buildVehicleMark(cleaned),
    tone: "generic",
  };
}

function parseVehicleItems(value: string | null | undefined) {
  if (!value) return [];
  const seen = new Set<string>();
  return value
    .split(/[,;\n|]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolveVehicleMeta(item))
    .filter((item) => {
      const key = item.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function VehicleBadges({
  value,
  compact = false,
  limit = 4,
  expandable = false,
  className = "",
}: VehicleBadgesProps) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => parseVehicleItems(value), [value]);

  if (!items.length) return <span>-</span>;

  const visibleItems = expanded ? items : items.slice(0, limit);
  const hiddenCount = items.length - visibleItems.length;

  return (
    <div className={`vehicle-badge-list${compact ? " vehicle-badge-list--compact" : ""}${className ? ` ${className}` : ""}`}>
      {visibleItems.map((item) => (
        <span
          key={item.label}
          className={`vehicle-badge vehicle-badge--${item.tone}${compact ? " vehicle-badge--compact" : ""}`}
          title={item.label}
        >
          <span className="vehicle-badge__mark">{item.mark}</span>
          {!compact ? <span className="vehicle-badge__label">{item.label}</span> : null}
        </span>
      ))}
      {expandable && hiddenCount > 0 ? (
        <button type="button" className="vehicle-badge-more" onClick={() => setExpanded(true)} title={items.slice(limit).map((item) => item.label).join(", ")}>
          ...{hiddenCount}
        </button>
      ) : null}
      {!expandable && hiddenCount > 0 ? (
        <span className="vehicle-badge-more" title={items.slice(limit).map((item) => item.label).join(", ")}>
          +{hiddenCount}
        </span>
      ) : null}
      {expandable && expanded && items.length > limit ? (
        <button type="button" className="vehicle-badge-more" onClick={() => setExpanded(false)}>
          Less
        </button>
      ) : null}
    </div>
  );
}
