import type { ReactNode } from "react";

type SectionCardProps = {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function SectionCard({ title, actions, children }: SectionCardProps) {
  return (
    <section className="section-card">
      <div className="section-card__header">
        <h2>{title}</h2>
        {actions ? <div className="section-card__actions">{actions}</div> : null}
      </div>
      <div className="section-card__body">{children}</div>
    </section>
  );
}
