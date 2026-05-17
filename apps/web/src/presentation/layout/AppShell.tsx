import type { ReactNode } from "react";

type AppShellProps = {
  children: ReactNode;
  activePage?: string;
  onNavigate?: (page: string) => void;
};

const navItems = [
  { key: "Home", code: "01", caption: "Overview" },
  { key: "Items", code: "02", caption: "Master Data" },
  { key: "Inventory", code: "03", caption: "Warehouses" },
  { key: "Sales", code: "04", caption: "Orders & AR" },
  { key: "Purchases", code: "05", caption: "Procurement" },
  { key: "Reports", code: "06", caption: "Analytics" },
  { key: "Settings", code: "07", caption: "Controls" },
] as const;

const pageMeta = {
  Home: { code: "01", eyebrow: "Overview", description: "Operational overview and live summaries" },
  Items: { code: "02", eyebrow: "Master Data", description: "Product codes, catalog definitions, and item master data" },
  Inventory: { code: "03", eyebrow: "Warehouses", description: "Warehouses, stock positions, and movement control" },
  Sales: { code: "04", eyebrow: "Orders & AR", description: "Sales orders, price lists, supplier sales pricing, and customer-facing flows" },
  Purchases: { code: "05", eyebrow: "Procurement", description: "Inbound procurement, receipts, and vendor-side workflows" },
  Reports: { code: "06", eyebrow: "Analytics", description: "Reporting views and analytical pricing comparisons" },
  Settings: { code: "07", eyebrow: "Controls", description: "Application and company-level settings" },
} as const;

export function AppShell({ children, activePage = "Home", onNavigate }: AppShellProps) {
  const meta = pageMeta[activePage as keyof typeof pageMeta] || pageMeta.Home;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-panel">
          <div className="brand-panel__eyebrow">Drive Console</div>
          <div className="brand">Next Master</div>
          <div className="brand-panel__sub">Operational cockpit</div>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <button key={item.key} className={`nav-item${item.key === activePage ? " active" : ""}`} onClick={() => onNavigate?.(item.key)}>
              <span className="nav-item__code">{item.code}</span>
              <span className="nav-item__body">
                <span className="nav-item__title">{item.key}</span>
                <span className="nav-item__caption">{item.caption}</span>
              </span>
              <span className="nav-item__indicator" />
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-panel">
            <span className="topbar-panel__code">{meta.code}</span>
            <div className="topbar-panel__content">
              <div className="topbar-panel__eyebrow">{meta.eyebrow}</div>
              <h1>{activePage}</h1>
              <p>{meta.description}</p>
            </div>
          </div>
        </header>
        {children}
      </main>
    </div>
  );
}
