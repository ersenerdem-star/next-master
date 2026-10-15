// The admin shell and dashboard resolve the same existing page/tab contract.
// Display labels never create a second routing or permission model.
export type WorkspaceSection = { key: string; label: string };
export type WorkspaceSections = Record<string, readonly WorkspaceSection[]>;
export type WorkspaceDestination = { page: string; section?: string };

export const workspaceGroups = [
  { key: "workspace", labelKey: "nav.home", pages: ["Home", "Mira"] },
  { key: "catalog", labelKey: "nav.catalog", pages: ["Items", "CatalogReview"] },
  { key: "purchasing", labelKey: "nav.purchases", pages: ["Purchases"] },
  { key: "sales", labelKey: "nav.sales", pages: ["Sales"] },
  { key: "inventory", labelKey: "nav.inventory", pages: ["Inventory"] },
  { key: "reports", labelKey: "nav.reports", pages: ["Reports"] },
  { key: "settings", labelKey: "nav.settings", pages: ["Settings"] },
] as const;

export function resolveWorkspaceDestination(
  page: string,
  section: string | undefined,
  allowedPages: readonly { key: string }[],
  sections: WorkspaceSections,
): WorkspaceDestination | null {
  if (!allowedPages.some((item) => item.key === page)) return null;
  // Compatibility for the dashboard label introduced by the reference shell.
  const canonical = page === "Purchases" && section === "Supplier Price Upload" ? "Supplier Prices" : section;
  if (canonical && !sections[page]?.some((item) => item.key === canonical)) return null;
  return { page, ...(canonical ? { section: canonical } : {}) };
}

export function workspaceNavigationItems(
  allowedPages: readonly { key: string; label: string }[],
  sections: WorkspaceSections,
) {
  return workspaceGroups.map((group) => ({
    ...group,
    items: (group.pages as readonly string[]).flatMap<{ page: string; section: string | undefined; label: string }>((page) => {
      const allowed = allowedPages.find((item) => item.key === page);
      if (!allowed) return [];
      const children = sections[page] || [];
      return children.length
        ? children.map((section) => ({ page, section: section.key, label: section.label }))
        : [{ page, section: undefined, label: allowed.label }];
    }),
  })).filter((group) => group.items.length > 0);
}
