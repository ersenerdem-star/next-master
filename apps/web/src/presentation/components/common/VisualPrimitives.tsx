import type { ReactNode } from "react";

type PageShellProps = {
  children: ReactNode;
  className?: string;
};

export function PageShell({ children, className = "" }: PageShellProps) {
  return <div className={`page-shell ${className}`.trim()}>{children}</div>;
}

type PageHeaderProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, eyebrow, subtitle, status, actions, className = "" }: PageHeaderProps) {
  return (
    <header className={`page-header ${className}`.trim()}>
      <div className="page-header__copy">
        {eyebrow ? <span className="page-header__eyebrow">{eyebrow}</span> : null}
        <div className="page-header__title-row">
          <h1>{title}</h1>
          {status ? <div className="page-header__status">{status}</div> : null}
        </div>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {actions ? <PageActions>{actions}</PageActions> : null}
    </header>
  );
}

export function PageActions({ children, className = "" }: PageShellProps) {
  return <div className={`page-actions ${className}`.trim()}>{children}</div>;
}

export function CompactFilterBar({ children, className = "" }: PageShellProps) {
  return <div className={`compact-filter-bar ${className}`.trim()}>{children}</div>;
}

export function DataTableShell({ children, className = "" }: PageShellProps) {
  return <div className={`data-table-shell ${className}`.trim()}>{children}</div>;
}

type StatusBadgeProps = {
  children: ReactNode;
  tone?: "neutral" | "success" | "info" | "warning" | "danger";
  className?: string;
};

export function StatusBadge({ children, tone = "neutral", className = "" }: StatusBadgeProps) {
  return <span className={`status-badge status-badge--${tone} ${className}`.trim()}>{children}</span>;
}

type StateProps = {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function EmptyState({ title, children, className = "" }: StateProps) {
  return (
    <div className={`empty-state visual-state ${className}`.trim()}>
      {title ? <strong>{title}</strong> : null}
      {children ? <span>{children}</span> : null}
    </div>
  );
}

export function LoadingState({ title, children, className = "" }: StateProps) {
  return (
    <div className={`visual-state visual-state--loading ${className}`.trim()} role="status">
      <span className="visual-state__spinner" aria-hidden="true" />
      <div>
        {title ? <strong>{title}</strong> : null}
        {children ? <span>{children}</span> : null}
      </div>
    </div>
  );
}

type InlineAlertProps = StateProps & {
  tone?: "info" | "warning" | "danger" | "success";
};

export function InlineAlert({ title, children, tone = "info", className = "" }: InlineAlertProps) {
  return (
    <div className={`inline-alert inline-alert--${tone} ${className}`.trim()} role={tone === "danger" ? "alert" : "status"}>
      {title ? <strong>{title}</strong> : null}
      {children ? <span>{children}</span> : null}
    </div>
  );
}
