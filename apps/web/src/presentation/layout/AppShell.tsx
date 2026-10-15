import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { NextMasterLogo, NavGlyph, navGlyphForKey } from "../components/common/NextMasterBrand";
import { workspaceNavigationItems, type WorkspaceSections } from "../../modules/admin/workspaceNavigation";

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
  accountName?: string;
  accountEmail?: string;
  accountRole?: string;
  onOpenAccount?: () => void;
  onLogout?: () => void | Promise<void>;
  activePage?: string;
  activeSubPage?: string;
  notice?: string;
  onDismissNotice?: () => void;
  navItems?: readonly NavItem[];
  subNavItems?: readonly SubNavItem[];
  onNavigate?: (page: string) => void;
  onNavigateSub?: (subPage: string) => void;
  pageSections?: WorkspaceSections;
  onNavigateTarget?: (page: string, section?: string) => void;
  userEmail?: string;
  userRole?: string;
};

const pageMeta = {
  Home: { code: "01", eyebrowKey: "nav.home", titleKey: "nav.home", descriptionKey: "nav.homeCaption" },
  Items: { code: "02", eyebrowKey: "nav.items", titleKey: "nav.items", descriptionKey: "nav.itemsCaption" },
  CatalogReview: { code: "02R", eyebrowKey: "nav.catalogReview", titleKey: "nav.catalogReview", descriptionKey: "nav.catalogReviewCaption" },
  Inventory: { code: "03", eyebrowKey: "nav.inventory", titleKey: "nav.inventory", descriptionKey: "nav.inventoryCaption" },
  Sales: { code: "04", eyebrowKey: "nav.sales", titleKey: "nav.sales", descriptionKey: "nav.salesCaption" },
  Purchases: { code: "05", eyebrowKey: "nav.purchases", titleKey: "nav.purchases", descriptionKey: "nav.purchasesCaption" },
  Reports: { code: "06", eyebrowKey: "nav.reports", titleKey: "nav.reports", descriptionKey: "nav.reportsCaption" },
  Messages: { code: "09", eyebrowKey: "nav.messages", titleKey: "nav.messages", descriptionKey: "nav.messages" },
  Settings: { code: "07", eyebrowKey: "nav.settings", titleKey: "nav.settings", descriptionKey: "nav.settingsCaption" },
  Mira: { code: "08", eyebrowKey: "nav.mira", titleKey: "nav.mira", descriptionKey: "nav.miraCaption" },
} as const;

export function AppShell({
  children,
  accountName = "", accountEmail = "", accountRole = "", onOpenAccount, onLogout,
  activePage = "Home",
  activeSubPage = "",
  notice = "",
  onDismissNotice,
  navItems = [],
  subNavItems = [],
  onNavigate,
  onNavigateSub,
  pageSections = {},
  onNavigateTarget,
  userEmail = "",
  userRole = "",
}: AppShellProps) {
  const { t, locale } = useI18n();
  const accountInitials = (accountName || accountEmail || userEmail).trim().split(/[\s@._-]+/).filter(Boolean).slice(0,2).map(part => part[0]).join("").toLocaleUpperCase(locale) || "?";
  const appDesktopFrameRef = useRef<HTMLDivElement | null>(null);
  const navigation = workspaceNavigationItems(navItems, pageSections);
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
    if (typeof window !== "undefined") window.scrollTo(0,0);
  }, [activePage,activeSubPage]);

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
          <NextMasterLogo theme="light" />
          <div className="brand-panel__eyebrow">{t("nav.driveConsole")}</div>
          <div className="brand-panel__sub">{t("nav.operationalCockpit")}</div>
        </div>
        <nav className="sidebar-nav">
          {navigation.map((group) => (
            <div key={group.key} className="reference-nav-group">
              <div className="sidebar-nav__section-label">{t(group.labelKey)}</div>
              {group.items.map((item) => {
                const isActive = item.page === activePage && (!item.section || item.section === activeSubPage);
                return (
                  <div key={`${item.page}:${item.section || "root"}`} className={`nav-group reference-nav-item-group${isActive ? " active" : ""}`}>
                    <button type="button" className={`nav-item reference-nav-item${isActive ? " active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                      onClick={() => onNavigateTarget ? onNavigateTarget(item.page, item.section) : onNavigate?.(item.page)}>
                      <NavGlyph name={navGlyphForKey(item.page)} />
                      <span className="nav-item__body"><span className="nav-item__title">{item.label}</span></span>
                      <span className="nav-item__indicator" />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main">
        <header className="topbar topbar--reference">
          <div className="topbar-search">
            {navItems.some((item) => item.key === "Items") ? <button type="button" className="module-tab" onClick={() => onNavigateTarget?.("Items", "Catalog")}>
              <NavGlyph name="search" /> {t("nav.catalog")}
            </button> : <strong>{t(meta.titleKey)}</strong>}
          </div>
          <div className="topbar-user-actions">
            {pageSections.Reports?.some((item) => item.key === "Status Center") ? <button type="button" className="topbar-icon-button" aria-label={t("nav.statusCenter")} onClick={() => onNavigateTarget?.("Reports", "Status Center")}>
              <NavGlyph name="reports" />
            </button> : null}
            <button type="button" className="topbar-icon-button topbar-icon-button--messages" aria-label={locale === "tr" ? "Mesajları aç" : "Open messages"} disabled={!navItems.some(item => item.key === "Messages")} onClick={() => onNavigate?.("Messages")}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M6 17h12l-1.2-1.7V10a4.8 4.8 0 0 0-9.6 0v5.3Z" />
                <path d="M10 20h4" />
              </svg>
            </button>
            <details className="topbar-account-menu" onKeyDown={event => {if(event.key === "Escape") event.currentTarget.removeAttribute("open");}}>
              <summary className="topbar-profile" aria-label={locale === "tr" ? "Hesap menüsü" : "Account menu"}>
                <span className="topbar-profile__avatar">{accountInitials}</span>
                <span className="topbar-profile__copy"><strong>{accountName || accountEmail || (locale === "tr" ? "Hesap" : "Account")}</strong><span>{accountRole || userRole}</span></span>
                <span className="topbar-profile__chevron" aria-hidden="true">⌄</span>
              </summary>
              <div className="topbar-account-menu__items">
                <strong>{accountName || accountEmail}</strong><span>{accountEmail}</span>
                <button type="button" className="button button--secondary" onClick={event => {event.currentTarget.closest("details")?.removeAttribute("open");onOpenAccount?.();}}>{locale === "tr" ? "Hesap ve oturum" : "Account and session"}</button>
                {pageSections.Settings?.filter(item => item.key === "users" || item.key === "portals").map(item => <button key={item.key} type="button" className="button button--secondary" onClick={event => {event.currentTarget.closest("details")?.removeAttribute("open");onNavigateTarget?.("Settings",item.key);}}>{item.label}</button>)}
                <button type="button" className="button button--secondary" onClick={() => void onLogout?.()}>{locale === "tr" ? "Çıkış yap" : "Sign out"}</button>
              </div>
            </details>
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
