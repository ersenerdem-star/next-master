import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const APP_DESKTOP_BASE_WIDTH_PX = 1440;
const APP_DESKTOP_SCALE_SIDE_PADDING_PX = 24;
const APP_MOBILE_LAYOUT_BREAKPOINT_PX = 768;

type SubNavItem = {
  key: string;
  label: string;
};

type NavItem = {
  key: string;
  code: string;
  caption: string;
};

type AppShellProps = {
  children: ReactNode;
  activePage?: string;
  activeSubPage?: string;
  notice?: string;
  onDismissNotice?: () => void;
  navItems?: readonly NavItem[];
  subNavItems?: readonly SubNavItem[];
  onNavigate?: (page: string) => void;
  onNavigateSub?: (subPage: string) => void;
};

const pageMeta = {
  Home: { code: "01", eyebrow: "Overview", description: "Operational overview and live summaries" },
  Items: { code: "02", eyebrow: "Master Data", description: "Product codes, catalog definitions, and item master data" },
  Inventory: { code: "03", eyebrow: "Warehouses", description: "Warehouses, stock positions, and movement control" },
  Sales: { code: "04", eyebrow: "Orders & AR", description: "Sales orders, price lists, supplier sales pricing, and customer-facing flows" },
  Purchases: { code: "05", eyebrow: "Procurement", description: "Inbound procurement, receipts, and vendor-side workflows" },
  Reports: { code: "06", eyebrow: "Analytics", description: "Reporting views and analytical pricing comparisons" },
  Settings: { code: "07", eyebrow: "Controls", description: "Application and company-level settings" },
} as const;

const buildMeta = __APP_BUILD_META__;

const contextMeta = {
  production: { label: "Production", className: "is-production" },
  "deploy-preview": { label: "Preview", className: "is-preview" },
  "branch-deploy": { label: "Branch", className: "is-branch" },
  local: { label: "Local", className: "is-local" },
} as const;

export function AppShell({
  children,
  activePage = "Home",
  activeSubPage = "",
  notice = "",
  onDismissNotice,
  navItems = [],
  subNavItems = [],
  onNavigate,
  onNavigateSub,
}: AppShellProps) {
  const appDesktopFrameRef = useRef<HTMLDivElement | null>(null);
  const meta = pageMeta[activePage as keyof typeof pageMeta] || pageMeta.Home;
  const context = contextMeta[buildMeta.context as keyof typeof contextMeta] || {
    label: buildMeta.context || "Build",
    className: "is-local",
  };
  const [appViewportWidth, setAppViewportWidth] = useState(() =>
    typeof window === "undefined" ? APP_DESKTOP_BASE_WIDTH_PX : window.innerWidth,
  );
  const [appDesktopFrameHeight, setAppDesktopFrameHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  const commitShort = buildMeta.commit.slice(0, 8);
  const builtAtLabel = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(buildMeta.builtAt));
  const shouldScaleAppDesktop =
    appViewportWidth > APP_MOBILE_LAYOUT_BREAKPOINT_PX &&
    appViewportWidth < APP_DESKTOP_BASE_WIDTH_PX;
  const appDesktopScale = shouldScaleAppDesktop
    ? Math.min(1, (appViewportWidth - APP_DESKTOP_SCALE_SIDE_PADDING_PX) / APP_DESKTOP_BASE_WIDTH_PX)
    : 1;
  const appDesktopScaledHeight = shouldScaleAppDesktop
    ? Math.max(
        typeof window === "undefined" ? 0 : window.innerHeight - APP_DESKTOP_SCALE_SIDE_PADDING_PX,
        Math.ceil(appDesktopFrameHeight * appDesktopScale),
      )
    : 0;
  const appDesktopStageStyle: CSSProperties | undefined = shouldScaleAppDesktop
    ? {
        "--app-desktop-scale": String(appDesktopScale),
        "--app-desktop-scaled-height": `${appDesktopScaledHeight}px`,
        "--app-desktop-base-width": `${APP_DESKTOP_BASE_WIDTH_PX}px`,
      } as CSSProperties
    : undefined;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncViewportWidth = () => setAppViewportWidth(window.innerWidth);
    syncViewportWidth();
    window.addEventListener("resize", syncViewportWidth);
    return () => window.removeEventListener("resize", syncViewportWidth);
  }, []);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const node = appDesktopFrameRef.current;
    if (!node) return;
    const syncFrameHeight = () => setAppDesktopFrameHeight(node.scrollHeight);
    syncFrameHeight();
    const observer = new ResizeObserver(syncFrameHeight);
    observer.observe(node);
    return () => observer.disconnect();
  }, [activePage, activeSubPage, children, notice, shouldScaleAppDesktop]);

  return (
    <div className={`app-desktop-stage${shouldScaleAppDesktop ? " app-desktop-stage--scaled" : ""}`} style={appDesktopStageStyle}>
      <div
        ref={appDesktopFrameRef}
        className={`app-desktop-frame${shouldScaleAppDesktop ? " app-desktop-frame--scaled" : ""}`}
      >
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-panel">
          <div className="brand-panel__eyebrow">Drive Console</div>
          <div className="brand">Next Master</div>
          <div className="brand-panel__sub">Operational cockpit</div>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <div key={item.key} className={`nav-group${item.key === activePage ? " active" : ""}`}>
              <button className={`nav-item${item.key === activePage ? " active" : ""}`} onClick={() => onNavigate?.(item.key)}>
                <span className="nav-item__code">{item.code}</span>
                <span className="nav-item__body">
                  <span className="nav-item__title">{item.key}</span>
                  <span className="nav-item__caption">{item.caption}</span>
                </span>
                <span className="nav-item__indicator" />
              </button>
              {item.key === activePage && subNavItems.length ? (
                <div className="nav-submenu" role="menu" aria-label={`${item.key} sections`}>
                  {subNavItems.map((subItem) => (
                    <button
                      key={subItem.key}
                      className={`nav-submenu__item${subItem.key === activeSubPage ? " active" : ""}`}
                      onClick={() => onNavigateSub?.(subItem.key)}
                    >
                      <span className="nav-submenu__dot" />
                      <span>{subItem.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
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
          <div className="topbar-build">
            <div className="topbar-build__eyebrow">Build Context</div>
            <div className="topbar-build__chips">
              <span className={`topbar-chip ${context.className}`}>{context.label}</span>
              <span className="topbar-chip">{buildMeta.branch}</span>
              <span className="topbar-chip">{commitShort}</span>
            </div>
            <div className="topbar-build__meta">
              <span>Built {builtAtLabel}</span>
              {buildMeta.deployUrl ? <span>Deploy ready</span> : null}
            </div>
          </div>
        </header>
        {subNavItems.length ? (
          <div className="mobile-subnav" role="tablist" aria-label={`${activePage} mobile sections`}>
            {subNavItems.map((subItem) => (
              <button
                key={subItem.key}
                className={`mobile-subnav__item${subItem.key === activeSubPage ? " active" : ""}`}
                onClick={() => onNavigateSub?.(subItem.key)}
              >
                {subItem.label}
              </button>
            ))}
          </div>
        ) : null}
        {notice ? (
          <div className="app-shell-notice" role="alert">
            <span>{notice}</span>
            <button type="button" className="app-shell-notice__dismiss" onClick={onDismissNotice}>
              Close
            </button>
          </div>
        ) : null}
        {children}
      </main>
      <nav className="mobile-bottom-nav" aria-label="Primary mobile navigation">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`mobile-bottom-nav__item${item.key === activePage ? " active" : ""}`}
            onClick={() => onNavigate?.(item.key)}
          >
            <span className="mobile-bottom-nav__title">{item.key}</span>
            <span className="mobile-bottom-nav__caption">{item.caption}</span>
          </button>
        ))}
      </nav>
    </div>
      </div>
    </div>
  );
}
