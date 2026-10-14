import React, { type ReactNode } from "react";

/** Native disclosure preserves the full history and its existing controls. */
export function SupplierLegacyHistory({ enabled, title, summary, children }: {
  enabled: boolean; title: string; summary: string; children: ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return <details className="operations-secondary-details supplier-legacy-history">
    <summary><span>{title}</span><small>{summary}</small></summary>
    {children}
  </details>;
}
