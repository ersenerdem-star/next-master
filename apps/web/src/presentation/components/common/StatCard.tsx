type StatCardProps = {
  label: string;
  value: string;
  subtext: string;
  tone?: "neutral" | "success" | "warning";
  onClick?: () => void;
};

export function StatCard({ label, value, subtext, tone = "neutral", onClick }: StatCardProps) {
  if (onClick) {
    return (
      <button type="button" className={`stat-card stat-card--${tone} stat-card--clickable`} onClick={onClick}>
        <span className="stat-card__label">{label}</span>
        <strong className="stat-card__value">{value}</strong>
        <span className="stat-card__subtext">{subtext}</span>
      </button>
    );
  }

  return (
    <section className={`stat-card stat-card--${tone}`}>
      <span className="stat-card__label">{label}</span>
      <strong className="stat-card__value">{value}</strong>
      <span className="stat-card__subtext">{subtext}</span>
    </section>
  );
}
