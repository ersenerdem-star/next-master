import type { MasterRow } from "../../../types/master";
import { BrandPill } from "../common/BrandPill";
import { formatBrandAwareProductCode } from "../../../shared/productCodeDisplay";

export const HIGH_GAP_PERCENT = 10;

type RiskTone = "neutral" | "success" | "warning" | "danger" | "info";

type MetricTileProps = {
  label: string;
  value: string;
  detail?: string;
  tone?: RiskTone;
};

type RiskBadgeProps = {
  label: string;
  tone?: RiskTone;
};

type MoneyCellProps = {
  value: number | null | undefined;
  currency?: string;
  precision?: number;
  muted?: boolean;
};

type PercentCellProps = {
  value: number | null | undefined;
  precision?: number;
  muted?: boolean;
};

export function formatMasterNumber(value: number | null | undefined, fractionDigits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function getMasterRowRisk(row: MasterRow) {
  const supplierCount = Number(row.supplier_count ?? 0);
  const hasBestPrice = row.cheapest_price != null && Boolean(String(row.cheapest_supplier || "").trim());
  const hasSecondSupplier = row.second_price != null || Boolean(String(row.second_supplier_name || "").trim());
  const gapPercent = row.price_gap_percent == null ? null : Number(row.price_gap_percent);

  if (!hasBestPrice) {
    return { label: "No price", tone: "danger" as RiskTone };
  }
  if (!hasSecondSupplier || supplierCount <= 1) {
    return { label: "Single supplier", tone: "warning" as RiskTone };
  }
  if (gapPercent != null && gapPercent >= HIGH_GAP_PERCENT) {
    return { label: "High gap", tone: "info" as RiskTone };
  }
  return { label: "Competitive", tone: "success" as RiskTone };
}

export function MetricTile({ label, value, detail, tone = "neutral" }: MetricTileProps) {
  return (
    <div className={`metric-tile metric-tile--${tone}`}>
      <span className="metric-tile__label">{label}</span>
      <strong className="metric-tile__value">{value}</strong>
      {detail ? <span className="metric-tile__detail">{detail}</span> : null}
    </div>
  );
}

export function RiskBadge({ label, tone = "neutral" }: RiskBadgeProps) {
  return <span className={`risk-badge risk-badge--${tone}`}>{label}</span>;
}

export function MoneyCell({ value, currency = "EUR", precision = 2, muted = false }: MoneyCellProps) {
  return (
    <span className={`money-cell${muted ? " money-cell--muted" : ""}`}>
      {formatMasterNumber(value, precision)}
      {value == null ? null : <span className="money-cell__currency">{currency}</span>}
    </span>
  );
}

export function PercentCell({ value, precision = 2, muted = false }: PercentCellProps) {
  return <span className={`percent-cell${muted ? " percent-cell--muted" : ""}`}>{value == null ? "-" : `${formatMasterNumber(value, precision)}%`}</span>;
}

export function ProductIdentityCell({ row }: { row: MasterRow }) {
  return (
    <div className="product-identity-cell">
      <div className="product-identity-cell__top">
        <span className="product-identity-cell__code">{formatBrandAwareProductCode(row.product_code, row.brand) || "-"}</span>
        <BrandPill brand={row.brand} compact />
      </div>
      <div className="product-identity-cell__description">{row.description || "No description"}</div>
      <div className="product-identity-cell__chips">
        {row.oem_no ? <span className="procurement-chip">OEM {row.oem_no}</span> : null}
        {row.catalog_status ? <span className="procurement-chip procurement-chip--muted">{row.catalog_status}</span> : null}
      </div>
    </div>
  );
}

export function SupplierComparisonCell({ row }: { row: MasterRow }) {
  const risk = getMasterRowRisk(row);

  return (
    <div className="supplier-decision-cell">
      <div className="supplier-decision-cell__supplier">{row.cheapest_supplier || "No supplier"}</div>
      <div className="supplier-decision-cell__badges">
        {row.cheapest_supplier ? <RiskBadge label="Best" tone="success" /> : null}
        <RiskBadge label={risk.label} tone={risk.tone} />
      </div>
      <span className="supplier-decision-cell__count">{row.supplier_count ?? 0} supplier(s)</span>
    </div>
  );
}
