import { Component, Suspense, lazy, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { clearCachedAppSession, fetchAppSession, getCachedAppSessionSnapshot } from "../infrastructure/api/appSessionApi";
import { supabaseClient } from "../infrastructure/api/supabaseClient";
import { touchCurrentUserPresence } from "../infrastructure/api/usersApi";
import { ActionFeedbackProvider } from "../presentation/components/common/ActionFeedback";
import { AppShell } from "../presentation/layout/AppShell";
import { APP_NAVIGATION_EVENT, type AppNavigationDetail } from "../shared/catalogTransfer";
import {
  canAccessCustomerOps,
  canAccessInventoryModules,
  canAccessOperationsModules,
  canAccessPurchasingModules,
  canAccessReportModules,
  canAccessSalesModules,
  canAccessSystemModules,
  isSuperadminRole,
  normalizeAppRole,
  type AppRole,
} from "../shared/roles";

const DashboardPage = lazy(() => import("../modules/admin/pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const InventoryPage = lazy(() => import("../modules/warehouse/pages/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const ItemsPage = lazy(() => import("../modules/admin/pages/ItemsPage").then((module) => ({ default: module.ItemsPage })));
const LoginPage = lazy(() => import("../modules/admin/pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const PortalPage = lazy(() => import("../modules/portal/pages/PortalPage").then((module) => ({ default: module.PortalPage })));
const PurchasesPage = lazy(() => import("../modules/admin/pages/PurchasesPage").then((module) => ({ default: module.PurchasesPage })));
const ReportsPage = lazy(() => import("../modules/admin/pages/ReportsPage").then((module) => ({ default: module.ReportsPage })));
const SalesPage = lazy(() => import("../modules/admin/pages/SalesPage").then((module) => ({ default: module.SalesPage })));
const SettingsPage = lazy(() => import("../modules/admin/pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

const itemSubNav = [
  { key: "Catalog", label: "Catalog" },
  { key: "Code References", label: "Code References" },
] as const;

const inventorySubNav = [
  { key: "Warehouses", label: "Warehouses" },
  { key: "Purchase Receives", label: "Purchase Receives" },
  { key: "Stock Movements", label: "Stock Movements" },
  { key: "On Hand", label: "On Hand" },
  { key: "Transfers", label: "Transfers" },
] as const;

const salesSubNav = [
  { key: "Customers", label: "Customers" },
  { key: "Sales Orders", label: "Sales Orders" },
  { key: "Invoices", label: "Invoices" },
  { key: "Payments Received", label: "Payments Received" },
  { key: "Price Lists", label: "Price Lists" },
] as const;

const purchasesSubNav = [
  { key: "Vendors", label: "Vendors" },
  { key: "Purchase Orders", label: "Purchase Orders" },
  { key: "Bills", label: "Bills" },
  { key: "Payments Made", label: "Payments Made" },
] as const;

const reportsSubNav = [
  { key: "Master", label: "Master" },
  { key: "Item Transactions", label: "Item Transactions" },
  { key: "Inventory Analytics", label: "Inventory Analytics" },
] as const;

const settingsSubNav = [
  { key: "session", label: "Session" },
  { key: "users", label: "Users" },
  { key: "companies", label: "Companies" },
  { key: "portals", label: "Portals" },
  { key: "templates", label: "Templates" },
  { key: "emails", label: "Outgoing Emails" },
  { key: "diagnostics", label: "Diagnostics" },
] as const;

const APP_UI_STATE_KEY = "next-master-app-ui-state";

type PersistedAppUiState = {
  activePage?: string;
  itemsTab?: "Catalog" | "Code References";
  inventoryInitialTab?: "Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers";
  inventorySelectedWarehouseId?: string;
  inventoryStockSearch?: string;
  salesTab?: "Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists";
  purchasesTab?: "Vendors" | "Purchase Orders" | "Bills" | "Payments Made";
  reportsTab?: "Master" | "Item Transactions" | "Inventory Analytics";
  settingsTab?: "session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics";
};

function readPersistedAppUiState() {
  if (typeof window === "undefined") return null as PersistedAppUiState | null;
  try {
    const raw = window.localStorage.getItem(APP_UI_STATE_KEY);
    return raw ? (JSON.parse(raw) as PersistedAppUiState) : null;
  } catch {
    return null;
  }
}

function writePersistedAppUiState(next: PersistedAppUiState | null) {
  if (typeof window === "undefined") return;
  if (!next) {
    window.localStorage.removeItem(APP_UI_STATE_KEY);
    return;
  }
  window.localStorage.setItem(APP_UI_STATE_KEY, JSON.stringify(next));
}

const allNavItems = [
  { key: "Home", code: "01", caption: "Overview" },
  { key: "Items", code: "02", caption: "Master Data" },
  { key: "Inventory", code: "03", caption: "Warehouses" },
  { key: "Sales", code: "04", caption: "Orders & AR" },
  { key: "Purchases", code: "05", caption: "Procurement" },
  { key: "Reports", code: "06", caption: "Analytics" },
  { key: "Settings", code: "07", caption: "Controls" },
] as const;

function getAllowedNavItems(role: AppRole) {
  if (isSuperadminRole(role)) return allNavItems;
  if (canAccessOperationsModules(role)) {
    return allNavItems.filter((item) => item.key === "Home" || item.key === "Inventory" || item.key === "Sales" || item.key === "Purchases" || item.key === "Reports" || item.key === "Settings");
  }
  if (canAccessSalesModules(role)) {
    return allNavItems.filter((item) => item.key === "Home" || item.key === "Sales" || item.key === "Settings");
  }
  return allNavItems.filter((item) => item.key === "Home" || item.key === "Settings");
}

function getSalesSubNav(role: AppRole) {
  if (!canAccessSalesModules(role)) return [] as const;
  return salesSubNav.filter((item) => item.key !== "Price Lists" || isSuperadminRole(role));
}

function getInventorySubNav(role: AppRole) {
  if (!canAccessInventoryModules(role)) return [] as const;
  return inventorySubNav;
}

function getPurchasesSubNav(role: AppRole) {
  if (!canAccessPurchasingModules(role)) return [] as const;
  return purchasesSubNav;
}

function getReportsSubNav(role: AppRole) {
  if (!canAccessReportModules(role)) return [] as const;
  return reportsSubNav;
}

function getSettingsSubNav(role: AppRole) {
  if (isSuperadminRole(role)) return settingsSubNav;
  if (canAccessSalesModules(role)) {
    return settingsSubNav.filter((item) => item.key === "session" || item.key === "portals");
  }
  return settingsSubNav.filter((item) => item.key === "session");
}

function getDefaultPage(role: AppRole) {
  return canAccessSalesModules(role) ? "Sales" : "Home";
}

class PageErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(_error: unknown, _errorInfo: ErrorInfo) {}

  render() {
    if (this.state.hasError) {
      return (
        <div className="loading-screen">
          <div>
            <strong>Page failed to render.</strong>
            <div>Reload the workspace and try the menu again.</div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const isPortalRoute = typeof window !== "undefined" && window.location.pathname.startsWith("/portal");
  const initialUiState = typeof window === "undefined" || isPortalRoute ? null : readPersistedAppUiState();
  const initialAppSession = typeof window === "undefined" || isPortalRoute ? null : getCachedAppSessionSnapshot();
  const initialAppRole = normalizeAppRole(initialAppSession?.role || "");
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [appRole, setAppRole] = useState<AppRole>(initialAppRole);
  const [appRoleReady, setAppRoleReady] = useState(Boolean(initialAppRole));
  const appRoleRef = useRef<AppRole>(initialAppRole);
  const [appSessionReloadTick, setAppSessionReloadTick] = useState(0);
  const [activePage, setActivePage] = useState(initialUiState?.activePage || "Home");
  const [accessNotice, setAccessNotice] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [selectedSalesOrderId, setSelectedSalesOrderId] = useState("");
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [selectedPurchaseOrderId, setSelectedPurchaseOrderId] = useState("");
  const [selectedBillId, setSelectedBillId] = useState("");
  const [salesOrdersNavTick, setSalesOrdersNavTick] = useState(0);
  const [salesInvoicesNavTick, setSalesInvoicesNavTick] = useState(0);
  const [itemsTab, setItemsTab] = useState<"Catalog" | "Code References">(initialUiState?.itemsTab || "Catalog");
  const [inventoryInitialTab, setInventoryInitialTab] = useState<"Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers">(initialUiState?.inventoryInitialTab || "Warehouses");
  const [inventorySelectedWarehouseId, setInventorySelectedWarehouseId] = useState(initialUiState?.inventorySelectedWarehouseId || "");
  const [inventoryStockSearch, setInventoryStockSearch] = useState(initialUiState?.inventoryStockSearch || "");
  const [salesTab, setSalesTab] = useState<"Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists">(initialUiState?.salesTab || "Sales Orders");
  const [purchasesTab, setPurchasesTab] = useState<"Vendors" | "Purchase Orders" | "Bills" | "Payments Made">(initialUiState?.purchasesTab || "Vendors");
  const [reportsTab, setReportsTab] = useState<"Master" | "Item Transactions" | "Inventory Analytics">(initialUiState?.reportsTab || "Master");
  const [settingsTab, setSettingsTab] = useState<"session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics">(initialUiState?.settingsTab || "session");

  useEffect(() => {
    appRoleRef.current = appRole;
  }, [appRole]);

  useEffect(() => {
    if (isPortalRoute) return;
    writePersistedAppUiState({
      activePage,
      itemsTab,
      inventoryInitialTab,
      inventorySelectedWarehouseId,
      inventoryStockSearch,
      salesTab,
      purchasesTab,
      reportsTab,
      settingsTab,
    });
  }, [
    activePage,
    inventoryInitialTab,
    inventorySelectedWarehouseId,
    inventoryStockSearch,
    isPortalRoute,
    itemsTab,
    purchasesTab,
    reportsTab,
    salesTab,
    settingsTab,
  ]);

  useEffect(() => {
    let mounted = true;
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const isRecoveryLink = hashParams.get("type") === "recovery";

    supabaseClient.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setRecoveryMode(isRecoveryLink);
      setLoggedIn(Boolean(data.session) && !isRecoveryLink);
      setSessionReady(true);
    });

    const { data } = supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        clearCachedAppSession();
        setAppRole("");
        setAppRoleReady(true);
        setRecoveryMode(true);
        setLoggedIn(false);
        setSessionReady(true);
        return;
      }
      if (event === "SIGNED_OUT") {
        clearCachedAppSession();
        setAppRole("");
        setAppRoleReady(true);
        setRecoveryMode(false);
        setLoggedIn(false);
        setSessionReady(true);
        return;
      }

      if (!session) {
        clearCachedAppSession();
        setAppRole("");
        setAppRoleReady(true);
        setLoggedIn(false);
        setSessionReady(true);
        return;
      }

      setRecoveryMode(false);
      setLoggedIn(true);
      setSessionReady(true);

      if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        const cachedRole = normalizeAppRole(getCachedAppSessionSnapshot()?.role || "");
        const hasKnownRole = Boolean(appRoleRef.current || cachedRole);
        if (hasKnownRole) {
          setAppRole((current) => current || appRoleRef.current || cachedRole);
          setAppRoleReady(true);
        } else {
          clearCachedAppSession();
          setAppRole("");
          setAppRoleReady(false);
        }
        setAppSessionReloadTick((current) => current + 1);
      }
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!loggedIn || isPortalRoute) {
      setAppRole("");
      setAppRoleReady(true);
      return;
    }

    let cancelled = false;
    const roleTimeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setAppRole((current) => current || appRoleRef.current || "");
      setAppRoleReady(true);
    }, 10000);
    if (!appRoleRef.current) {
      setAppRoleReady(false);
    }

    async function run() {
      try {
        const session = await fetchAppSession(true);
        if (cancelled) return;
        setAppRole(normalizeAppRole(session.role));
      } catch {
        if (!cancelled) {
          setAppRole((current) => current || appRoleRef.current || "");
        }
      } finally {
        if (!cancelled) {
          window.clearTimeout(roleTimeoutId);
          setAppRoleReady(true);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      window.clearTimeout(roleTimeoutId);
    };
  }, [appSessionReloadTick, loggedIn, isPortalRoute]);

  useEffect(() => {
    if (!loggedIn || isPortalRoute) return;

    let disposed = false;

    const touch = async () => {
      if (disposed) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        await touchCurrentUserPresence();
      } catch {
        // Presence heartbeat is best-effort; it should not block the app.
      }
    };

    void touch();
    const intervalId = window.setInterval(() => {
      void touch();
    }, 15 * 60 * 1000);

    const handleFocus = () => {
      void touch();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void touch();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [loggedIn, isPortalRoute]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleNavigation = (event: Event) => {
      const detail = (event as CustomEvent<AppNavigationDetail>).detail;
      if (!detail?.page) return;

      setSelectedSalesOrderId("");
      setSelectedQuoteId("");
      setSelectedInvoiceId("");
      setSelectedPurchaseOrderId("");
      setSelectedBillId("");

      if (detail.page === "Sales") {
        setActivePage("Sales");
        setSalesTab("Sales Orders");
        return;
      }
      if (detail.page === "Purchases") {
        setActivePage("Purchases");
        setPurchasesTab("Purchase Orders");
      }
    };

    window.addEventListener(APP_NAVIGATION_EVENT, handleNavigation as EventListener);
    return () => {
      window.removeEventListener(APP_NAVIGATION_EVENT, handleNavigation as EventListener);
    };
  }, []);

  async function handleLogout() {
    await supabaseClient.auth.signOut();
  }

  function renderPageFallback(message: string) {
    return <div className="loading-screen">{message}</div>;
  }

  function showAccessNotice(message: string) {
    setAccessNotice(message);
  }

  function openSalesOrder(salesOrderId: string) {
    if (!canAccessSalesModules(appRole)) {
      showAccessNotice("Sales access is not enabled for this user. Ask superadmin to open the sales workflow.");
      return;
    }
    setSelectedSalesOrderId(salesOrderId);
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
    setSelectedPurchaseOrderId("");
    setSelectedBillId("");
    setSalesTab("Sales Orders");
    setActivePage("Sales");
  }

  function openPurchaseOrder(purchaseOrderId: string) {
    if (!canAccessPurchasingModules(appRole)) {
      showAccessNotice("Purchase access is not enabled for this user. Ask superadmin to open purchase permissions.");
      return;
    }
    setSelectedPurchaseOrderId(purchaseOrderId);
    setSelectedBillId("");
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
    setPurchasesTab("Purchase Orders");
    setActivePage("Purchases");
  }

  function openInvoice(invoiceId: string) {
    if (!canAccessSalesModules(appRole)) {
      showAccessNotice("Invoice access is not enabled for this user. Ask superadmin to open the sales workflow.");
      return;
    }
    setSelectedInvoiceId(invoiceId);
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedPurchaseOrderId("");
    setSelectedBillId("");
    setSalesTab("Invoices");
    setActivePage("Sales");
  }

  function openBill(billId: string) {
    if (!canAccessPurchasingModules(appRole)) {
      showAccessNotice("Bill access is not enabled for this user. Ask superadmin to open purchase permissions.");
      return;
    }
    setSelectedBillId(billId);
    setSelectedPurchaseOrderId("");
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
    setPurchasesTab("Bills");
    setActivePage("Purchases");
  }

  function openInventoryWarehouse(warehouseId: string) {
    if (!canAccessInventoryModules(appRole)) {
      showAccessNotice("Warehouse access is not enabled for this user. Ask superadmin to open warehouse permissions.");
      return;
    }
    setInventoryInitialTab("On Hand");
    setInventorySelectedWarehouseId(warehouseId);
    setInventoryStockSearch("");
    setActivePage("Inventory");
  }

  function openInventoryTab(tab: "Warehouses" | "On Hand") {
    if (!canAccessInventoryModules(appRole)) {
      showAccessNotice("Warehouse access is not enabled for this user. Ask superadmin to open warehouse permissions.");
      return;
    }
    setInventoryInitialTab(tab);
    setInventorySelectedWarehouseId("");
    setInventoryStockSearch("");
    setActivePage("Inventory");
  }

  function openInventoryItem(codeSearch: string, warehouseId?: string) {
    if (!canAccessInventoryModules(appRole)) {
      showAccessNotice("Warehouse access is not enabled for this user. Ask superadmin to open warehouse permissions.");
      return;
    }
    setInventoryInitialTab("On Hand");
    setInventorySelectedWarehouseId(warehouseId || "");
    setInventoryStockSearch(codeSearch);
    setActivePage("Inventory");
  }

  function openRelatedRecord(relatedType: string, relatedId: string) {
    if (relatedType === "portal_invite") {
      setSettingsTab("portals");
      setActivePage("Settings");
      return;
    }
    if (relatedType === "purchase_order") {
      openPurchaseOrder(relatedId);
      return;
    }
    if (relatedType === "bill") {
      openBill(relatedId);
      return;
    }
    if (relatedType === "invoice") {
      openInvoice(relatedId);
      return;
    }
    if (relatedType === "sales_order") {
      openSalesOrder(relatedId);
    }
  }

  function handleMainNavigate(nextPage: string) {
    if (!allowedNavItems.some((item) => item.key === nextPage)) {
      if (nextPage === "Items") {
        showAccessNotice("Catalog and supplier master data are enabled only for superadmin.");
      } else if (nextPage === "Purchases" || nextPage === "Inventory" || nextPage === "Reports") {
        showAccessNotice("This operation area is not enabled for your user. Ask superadmin to open purchase or warehouse permissions.");
      } else {
        showAccessNotice("This area is not enabled for your user. Ask superadmin to open the required permission.");
      }
      return;
    }
    setAccessNotice("");
    setActivePage(nextPage);
  }

  function handleSubNavigate(nextSubPage: string) {
    if (activePage === "Items" && itemSubNav.some((item) => item.key === nextSubPage)) {
      setItemsTab(nextSubPage as "Catalog" | "Code References");
      return;
    }
    if (activePage === "Inventory" && inventorySubNav.some((item) => item.key === nextSubPage)) {
      if (!inventorySubNavItems.some((item) => item.key === nextSubPage)) {
        showAccessNotice("This inventory detail is not enabled for your user. Ask superadmin to open warehouse permissions.");
        return;
      }
      setInventoryInitialTab(nextSubPage as "Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers");
      return;
    }
    if (activePage === "Sales" && salesSubNavItems.some((item) => item.key === nextSubPage)) {
      if (nextSubPage === "Sales Orders") {
        setSelectedSalesOrderId("");
        setSelectedQuoteId("");
        setSalesOrdersNavTick((current) => current + 1);
      }
      if (nextSubPage === "Invoices") {
        setSelectedInvoiceId("");
        setSalesInvoicesNavTick((current) => current + 1);
      }
      setSalesTab(nextSubPage as "Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists");
      return;
    }
    if (activePage === "Purchases" && purchasesSubNav.some((item) => item.key === nextSubPage)) {
      if (!purchasesSubNavItems.some((item) => item.key === nextSubPage)) {
        showAccessNotice("This purchase detail is not enabled for your user. Ask superadmin to open purchase permissions.");
        return;
      }
      setPurchasesTab(nextSubPage as "Vendors" | "Purchase Orders" | "Bills" | "Payments Made");
      return;
    }
    if (activePage === "Reports" && reportsSubNav.some((item) => item.key === nextSubPage)) {
      if (!reportsSubNavItems.some((item) => item.key === nextSubPage)) {
        showAccessNotice("This report is not enabled for your user. Ask superadmin to open this permission.");
        return;
      }
      setReportsTab(nextSubPage as "Master" | "Item Transactions" | "Inventory Analytics");
      return;
    }
    if (activePage === "Settings" && settingsSubNavItems.some((item) => item.key === nextSubPage)) {
      setSettingsTab(nextSubPage as "session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics");
      setAccessNotice("");
      return;
    }
    showAccessNotice("This detail is not enabled for your user. Ask superadmin to open the required permission.");
  }

  const salesSubNavItems = useMemo(() => getSalesSubNav(appRole), [appRole]);
  const inventorySubNavItems = useMemo(() => getInventorySubNav(appRole), [appRole]);
  const purchasesSubNavItems = useMemo(() => getPurchasesSubNav(appRole), [appRole]);
  const reportsSubNavItems = useMemo(() => getReportsSubNav(appRole), [appRole]);
  const settingsSubNavItems = useMemo(() => getSettingsSubNav(appRole), [appRole]);
  const allowedNavItems = useMemo(() => getAllowedNavItems(appRole), [appRole]);

  useEffect(() => {
    if (!appRoleReady || !allowedNavItems.length) return;
    if (!allowedNavItems.some((item) => item.key === activePage)) {
      setActivePage(getDefaultPage(appRole));
    }
  }, [activePage, allowedNavItems, appRole, appRoleReady]);

  useEffect(() => {
    if (salesSubNavItems.length && !salesSubNavItems.some((item) => item.key === salesTab)) {
      const firstItem = salesSubNavItems[0];
      if (firstItem) {
        setSalesTab(firstItem.key as "Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists");
      }
    }
  }, [salesSubNavItems, salesTab]);

  useEffect(() => {
    if (inventorySubNavItems.length && !inventorySubNavItems.some((item) => item.key === inventoryInitialTab)) {
      const firstItem = inventorySubNavItems[0];
      if (firstItem) {
        setInventoryInitialTab(firstItem.key as "Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers");
      }
    }
  }, [inventoryInitialTab, inventorySubNavItems]);

  useEffect(() => {
    if (purchasesSubNavItems.length && !purchasesSubNavItems.some((item) => item.key === purchasesTab)) {
      const firstItem = purchasesSubNavItems[0];
      if (firstItem) {
        setPurchasesTab(firstItem.key as "Vendors" | "Purchase Orders" | "Bills" | "Payments Made");
      }
    }
  }, [purchasesSubNavItems, purchasesTab]);

  useEffect(() => {
    if (reportsSubNavItems.length && !reportsSubNavItems.some((item) => item.key === reportsTab)) {
      const firstItem = reportsSubNavItems[0];
      if (firstItem) {
        setReportsTab(firstItem.key as "Master" | "Item Transactions" | "Inventory Analytics");
      }
    }
  }, [reportsSubNavItems, reportsTab]);

  useEffect(() => {
    if (settingsSubNavItems.length && !settingsSubNavItems.some((item) => item.key === settingsTab)) {
      const firstItem = settingsSubNavItems[0];
      if (firstItem) {
        setSettingsTab(firstItem.key as "session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics");
      }
    }
  }, [settingsSubNavItems, settingsTab]);

  const subNavItems =
    activePage === "Items" && canAccessSystemModules(appRole)
      ? itemSubNav
      : activePage === "Inventory" && canAccessInventoryModules(appRole)
        ? inventorySubNavItems
      : activePage === "Sales"
          ? salesSubNavItems
          : activePage === "Purchases" && canAccessPurchasingModules(appRole)
            ? purchasesSubNavItems
            : activePage === "Reports" && canAccessReportModules(appRole)
              ? reportsSubNavItems
              : activePage === "Settings"
                ? settingsSubNavItems
                : [];

  const activeSubPage =
    activePage === "Items"
      ? itemsTab
      : activePage === "Inventory"
        ? inventoryInitialTab
        : activePage === "Sales"
          ? salesTab
          : activePage === "Purchases"
            ? purchasesTab
            : activePage === "Reports"
              ? reportsTab
              : activePage === "Settings"
                ? settingsTab
                : "";

  if (isPortalRoute) {
    return (
      <ActionFeedbackProvider>
        <Suspense fallback={renderPageFallback("Loading portal...")}>
          <PageErrorBoundary key="portal">
            <PortalPage />
          </PageErrorBoundary>
        </Suspense>
      </ActionFeedbackProvider>
    );
  }

  if (!sessionReady) {
    return <div className="loading-screen">Checking session...</div>;
  }

  if (!loggedIn || recoveryMode) {
    return (
      <ActionFeedbackProvider>
        <Suspense fallback={renderPageFallback("Loading sign-in...")}>
          <LoginPage
            recoveryMode={recoveryMode}
            onSuccess={() => {
              setRecoveryMode(false);
              setLoggedIn(true);
            }}
          />
        </Suspense>
      </ActionFeedbackProvider>
    );
  }

  if (!appRoleReady) {
    return <div className="loading-screen">Loading workspace...</div>;
  }

  const pageContent =
    activePage === "Items" && canAccessSystemModules(appRole) ? (
      <ItemsPage activeTab={itemsTab} />
    ) : activePage === "Inventory" && canAccessInventoryModules(appRole) ? (
      <InventoryPage initialTab={inventoryInitialTab} selectedWarehouseId={inventorySelectedWarehouseId} stockSearch={inventoryStockSearch} />
    ) : activePage === "Sales" && canAccessSalesModules(appRole) ? (
      <SalesPage
        activeTab={salesTab}
        salesOrdersNavTick={salesOrdersNavTick}
        invoicesNavTick={salesInvoicesNavTick}
        selectedSalesOrderId={selectedSalesOrderId}
        onSelectedSalesOrderChange={setSelectedSalesOrderId}
        selectedQuoteId={selectedQuoteId}
        onSelectedQuoteChange={setSelectedQuoteId}
        selectedInvoiceId={selectedInvoiceId}
        onSelectedInvoiceChange={setSelectedInvoiceId}
      />
    ) : activePage === "Purchases" && canAccessPurchasingModules(appRole) ? (
      <PurchasesPage activeTab={purchasesTab} selectedPurchaseOrderId={selectedPurchaseOrderId} selectedBillId={selectedBillId} />
    ) : activePage === "Reports" && canAccessReportModules(appRole) ? (
      <ReportsPage
        activeTab={reportsTab}
        onOpenSalesOrder={openSalesOrder}
        onOpenPurchaseOrder={openPurchaseOrder}
        onOpenInvoice={openInvoice}
        onOpenBill={openBill}
        onOpenInventoryWarehouse={openInventoryWarehouse}
        onOpenInventoryItem={openInventoryItem}
      />
    ) : activePage === "Settings" ? (
      <SettingsPage initialTab={settingsTab} onLogout={handleLogout} onOpenRelatedRecord={openRelatedRecord} />
    ) : (
      <DashboardPage role={appRole} onOpenSalesOrder={openSalesOrder} onOpenInventoryTab={openInventoryTab} />
    );

  return (
    <ActionFeedbackProvider>
      <AppShell
        activePage={activePage}
        activeSubPage={activeSubPage}
        notice={accessNotice}
        onDismissNotice={() => setAccessNotice("")}
        navItems={allowedNavItems}
        subNavItems={subNavItems}
        onNavigate={handleMainNavigate}
        onNavigateSub={handleSubNavigate}
      >
        <Suspense fallback={renderPageFallback(`Loading ${activePage}...`)}>
          <PageErrorBoundary key={`${activePage}:${activeSubPage || "root"}`}>
            {pageContent}
          </PageErrorBoundary>
        </Suspense>
      </AppShell>
    </ActionFeedbackProvider>
  );
}
