import type { ReactNode } from "react";
import {useInterfaceText} from '../../../i18n/InterfaceText';

type SectionCardProps = {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function SectionCard({ title, actions, children, className = "" }: SectionCardProps) {
  const ui=useInterfaceText();
  return (
    <section className={`section-card ${className}`.trim()}>
      <div className="section-card__header">
        <h2>{typeof title==='string'?ui(title):title}</h2>
        {actions ? <div className="section-card__actions">{actions}</div> : null}
      </div>
      <div className="section-card__body">{children}</div>
    </section>
  );
}
