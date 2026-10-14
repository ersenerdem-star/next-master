import type { ReactNode } from "react";

type NextMasterLogoProps = {
  className?: string;
  theme?: "dark" | "light";
  compact?: boolean;
};

/** Shared Next Master mark and wordmark used by admin, portal, and auth surfaces. */
export function NextMasterLogo({ className = "", theme = "dark", compact = false }: NextMasterLogoProps) {
  return (
    <div className={`next-master-logo next-master-logo--${theme}${compact ? " next-master-logo--compact" : ""}${className ? ` ${className}` : ""}`}>
      <svg className="next-master-logo__mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <path d="M5 8.5 14.5 3l8 4.7-8.3 4.8L5 17.3Z" fill="currentColor" opacity=".92" />
        <path d="M5 17.3 14.2 12v17.2L5 34.5Z" fill="currentColor" opacity=".68" />
        <path d="m14.5 12.5 8-4.8 12.5 7.4-8.6 5-3.9-2.3-8 4.7Z" fill="#2ea7f4" />
        <path d="m14.2 29.2 8.3-4.8 12.5 7.3-9.2 5.3-11.6-6.8Z" fill="#1b78d0" opacity=".9" />
        <path d="M22.5 7.7v16.7l-8.3 4.8V12.5Z" fill="#59c8fb" opacity=".95" />
      </svg>
      {!compact ? (
        <span className="next-master-logo__lockup">
          <strong>NEXT MASTER</strong>
          <small>AUTOMOTIVE PARTS PLATFORM</small>
        </span>
      ) : null}
    </div>
  );
}

type NavGlyphName =
  | "home"
  | "catalog"
  | "review"
  | "inventory"
  | "sales"
  | "purchases"
  | "reports"
  | "settings"
  | "mira"
  | "search"
  | "pricing"
  | "documents"
  | "finance"
  | "account";

const glyphPaths: Record<NavGlyphName, ReactNode> = {
  home: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
  catalog: <><path d="M5 5h14v14H5z" /><path d="M8 9h8M8 13h5" /></>,
  review: <><path d="m4 12 5 5L20 6" /><path d="M4 5h4M4 19h4" /></>,
  inventory: <><path d="M4 8 12 4l8 4v8l-8 4-8-4Z" /><path d="M12 12 4 8M12 12l8-4M12 12v8" /></>,
  sales: <><path d="M4 18V7h16v11" /><path d="M7 4v3M17 4v3M4 10h16M8 14h3M14 14h2" /></>,
  purchases: <><path d="M4 6h16v14H4z" /><path d="M8 4v4M16 4v4M4 10h16M8 14h8" /></>,
  reports: <><path d="M5 19V9M12 19V5M19 19v-7" /><path d="M3 19h18" /></>,
  settings: <><path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1" /><circle cx="12" cy="12" r="3.2" /></>,
  mira: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  search: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" /></>,
  pricing: <><path d="M4 6h16v14H4z" /><path d="M8 10h8M8 14h5" /></>,
  documents: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h5M9 12h6M9 16h6" /></>,
  finance: <><path d="M5 5h14v14H5z" /><path d="M8 9h8M8 13h2M13 13h3M8 17h8" /></>,
  account: <><circle cx="12" cy="8" r="3" /><path d="M5 20c.9-3.2 3.2-5 7-5s6.1 1.8 7 5" /></>,
};

export function NavGlyph({ name }: { name: NavGlyphName }) {
  return <svg className="nav-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{glyphPaths[name]}</svg>;
}

export function navGlyphForKey(key: string): NavGlyphName {
  const map: Record<string, NavGlyphName> = {
    Home: "home",
    Items: "catalog",
    CatalogReview: "review",
    Inventory: "inventory",
    Sales: "sales",
    Purchases: "purchases",
    Reports: "reports",
    Settings: "settings",
    Mira: "mira",
  };
  return map[key] || "catalog";
}
