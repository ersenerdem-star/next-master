import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { NextMasterLogo, NavGlyph, navGlyphForKey } from "../components/common/NextMasterBrand";

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
  label: string;
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
  Home: { code: "01", eyebrowKey: "nav.home", titleKey: "nav.home", descriptionKey: "nav.homeCaption" },
  Items: { code: "02", eyebrowKey: "nav.items", titleKey: "nav.items", descriptionKey: "nav.itemsCaption" },
  CatalogReview: { code: "02R", eyebrowKey: "nav.catalogReview", titleKey: "nav.catalogReview", descriptionKey: "nav.catalogReviewCaption" },
  Inventory: { code: "03", eyebrowKey: "nav.inventory", titleKey: "nav.inventory", descriptionKey: "nav.inventoryCaption" },
  Sales: { code: "04", eyebrowKey: "nav.sales", titleKey: "nav.sales", descriptionKey: "nav.salesCaption" },
  Purchases: { code: "05", eyebrowKey: "nav.purchases", titleKey: "nav.purchases", descriptionKey: "nav.purchasesCaption" },
  Reports: { code: "06", eyebrowKey: "nav.reports", titleKey: "nav.reports", descriptionKey: "nav.reportsCaption" },
  Settings: { code: "07", eyebrowKey: "nav.settings", titleKey: "nav.settings", descriptionKey: "nav.settingsCaption" },
  Mira: { code: "08", eyebrowKey: "nav.mira", titleKey: "nav.mira", descriptionKey: "nav.miraCaption" },
} as const;

/**
 * The admin shell uses a compact, product-facing navigation vocabulary while
 * the application continues to route through its existing page keys. Keeping
 * this mapping in the shell lets the visual hierarchy stay stable as page
 * permissions and internal route names evolve.
 */
const referenceNavGroups = [
  {
    key: "workspace",
    label: "Workspace",
    items: [
      { key: "dashboard", label: "Dashboard", page: "Home", glyphKey: "Home", primary: true },
      { key: "tasks", label: "Tasks", page: "Mira", glyphKey: "Mira" },
      { key: "messages", label: "Messages", page: "Reports", glyphKey: "Reports" },
    ],
  },
  {
    key: "catalog",
    label: "Catalog",
    items: [
      { key: "parts-search", label: "Parts Search", page: "Items", glyphKey: "Items", primary: true },
      { key: "vehicles", label: "Vehicles", page: "Inventory", glyphKey: "Inventory", primary: true },
      { key: "oe-cross-reference", label: "OE Cross Reference", page: "CatalogReview", glyphKey: "CatalogReview", primary: true },
      { key: "suppliers", label: "Suppliers", page: "Purchases", glyphKey: "Purchases" },
    ],
  },
  {
    key: "purchasing",
    label: "Purchasing",
    items: [
      { key: "purchase-orders", label: "Purchase Orders", page: "Purchases", glyphKey: "Purchases", primary: true },
      { key: "supplier-price-upload", label: "Supplier Price Upload", page: "Purchases", glyphKey: "Purchases" },
      { key: "quotes", label: "Quotes", page: "Sales", glyphKey: "Sales" },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    items: [
      { key: "customer-price-lists", label: "Customer Price Lists", page: "Sales", glyphKey: "Sales", primary: true },
      { key: "orders", label: "Orders", page: "Sales", glyphKey: "Sales" },
      { key: "customers", label: "Customers", page: "Sales", glyphKey: "Sales" },
    ],
  },
  {
    key: "reports",
    label: "Reports",
    items: [
      { key: "sales-reports", label: "Sales Reports", page: "Reports", glyphKey: "Reports", primary: true },
      { key: "purchase-reports", label: "Purchase Reports", page: "Reports", glyphKey: "Reports" },
      { key: "inventory-reports", label: "Inventory Reports", page: "Reports", glyphKey: "Reports" },
    ],
  },
] as const;

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
  const { t } = useI18n();
  const appDesktopFrameRef = useRef<HTMLDivElement | null>(null);
  const activeSubmenuRef = useRef<HTMLDivElement | null>(null);
  const meta = pageMeta[activePage as keyof typeof pageMeta] || pageMeta.Home;
  const [appViewportWidth, setAppViewportWidth] = useState(() =>
    typeof window === "undefined" ? APP_DESKTOP_BASE_WIDTH_PX : window.innerWidth,
  );
  const [appDesktopFrameHeight, setAppDesktopFrameHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
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

  useEffect(() => {
    const submenu = activeSubmenuRef.current;
    const nav = submenu?.closest<HTMLElement>(".sidebar-nav");
    if (!submenu || !nav) return;

    // Keep the page position untouched when a submenu opens. Only the
    // navigation's own scroll container should move enough to reveal it.
    const submenuTop = submenu.offsetTop;
    const submenuBottom = submenuTop + submenu.offsetHeight;
    const visibleTop = nav.scrollTop;
    const visibleBottom = visibleTop + nav.clientHeight;
    if (submenuTop < visibleTop || submenuBottom > visibleBottom) {
      const centeredTop = submenuTop - Math.max(0, (nav.clientHeight - submenu.offsetHeight) / 2);
      nav.scrollTo({ top: Math.max(0, centeredTop), behavior: "smooth" });
    }
  }, [activePage, activeSubPage, subNavItems.length]);

  return (
    <div className={`app-desktop-stage${shouldScaleAppDesktop ? " app-desktop-stage--scaled" : ""}`} style={appDesktopStageStyle}>
      <div
        ref={appDesktopFrameRef}
        className={`app-desktop-frame${shouldScaleAppDesktop ? " app-desktop-frame--scaled" : ""}`}
      >
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-panel">
          <NextMasterLogo theme="light" />
          <div className="brand-panel__eyebrow">{t("nav.driveConsole")}</div>
          <div className="brand-panel__sub">{t("nav.operationalCockpit")}</div>
        </div>
        <nav className="sidebar-nav">
          {referenceNavGroups.map((group) => (
            <div key={group.key} className="reference-nav-group">
              <div className="sidebar-nav__section-label">{group.label}</div>
              {group.items.map((item) => {
                const isAllowed = navItems.some((navItem) => navItem.key === item.page);
                if (!isAllowed) return null;
                const isActive = ("primary" in item && item.primary === true) && item.page === activePage;
                const showSubmenu = isActive && subNavItems.length > 0;
                const routeLabel = navItems.find((navItem) => navItem.key === item.page)?.label || item.label;
                return (
                  <div key={item.key} className={`nav-group reference-nav-item-group${isActive ? " active" : ""}`}>
                    <button
                      type="button"
                      className={`nav-item reference-nav-item${isActive ? " active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => onNavigate?.(item.page)}
                    >
                      <NavGlyph name={navGlyphForKey(item.glyphKey)} />
                      <span className="nav-item__body">
                        <span className="nav-item__title">{item.label}</span>
                      </span>
                      <span className="nav-item__indicator" />
                    </button>
                    {showSubmenu ? (
                      <div
                        ref={activeSubmenuRef}
                        className="nav-submenu reference-nav-submenu"
                        role="menu"
                        aria-label={`${routeLabel} ${t("common.sections")}`}
                      >
                        {subNavItems.map((subItem) => (
                          <button
                            type="button"
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
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar topbar--reference">
          <div className="topbar-search" role="search">
            <NavGlyph name="search" />
            <input aria-label="Search parts, OE numbers, or suppliers" placeholder="Search parts, OE numbers, or suppliers..." />
            <kbd aria-label="Keyboard shortcut Command K">⌘ K</kbd>
          </div>
          <div className="topbar-user-actions">
            <button type="button" className="topbar-icon-button" aria-label="Notifications">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 17h12l-1.2-1.7V10a4.8 4.8 0 0 0-9.6 0v5.3Z" />
                <path d="M10 20h4" />
              </svg>
            </button>
            <div className="topbar-profile">
              <span className="topbar-profile__avatar">JD</span>
              <span className="topbar-profile__copy">
                <strong>John Davis</strong>
                <span>Procurement</span>
              </span>
              <span className="topbar-profile__chevron" aria-hidden="true">⌄</span>
            </div>
          </div>
        </header>
        {subNavItems.length ? (
          <div className="mobile-subnav" role="tablist" aria-label={`${t(meta.titleKey)} ${t("common.sections")}`}>
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
              {t("common.close")}
            </button>
          </div>
        ) : null}
        {children}
      </main>
      <nav className="mobile-bottom-nav" aria-label={t("common.primaryNavigation")}>
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`mobile-bottom-nav__item${item.key === activePage ? " active" : ""}`}
            onClick={() => onNavigate?.(item.key)}
          >
            <NavGlyph name={navGlyphForKey(item.key)} />
            <span className="mobile-bottom-nav__title">{item.label}</span>
            <span className="mobile-bottom-nav__caption">{item.caption}</span>
          </button>
        ))}
      </nav>
    </div>
      </div>
    </div>
  );
}
