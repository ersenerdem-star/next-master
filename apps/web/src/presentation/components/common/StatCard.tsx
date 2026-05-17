type StatCardProps = {
  label: string;
  value: string;
  subtext: string;
  tone?: "neutral" | "success" | "warning";
};

export function StatCard({ label, value, subtext, tone = "neutral" }: StatCardProps) {
  return (
    <section className={`stat-card stat-card--${tone}`}>
      <span className="stat-card__label">{label}</span>
      <strong className="stat-card__value">{value}</strong>
      <span className="stat-card__subtext">{subtext}</span>
    </section>
  );
}
