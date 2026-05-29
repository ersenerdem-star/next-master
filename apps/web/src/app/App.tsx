import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { clearCachedAppSession, fetchAppSession } from "../infrastructure/api/appSessionApi";
import { supabaseClient } from "../infrastructure/api/supabaseClient";
import { touchCurrentUserPresence } from "../infrastructure/api/usersApi";
import { ActionFeedbackProvider } from "../presentation/components/common/ActionFeedback";
import { AppShell } from "../presentation/layout/AppShell";
import { APP_NAVIGATION_EVENT, type AppNavigationDetail } from "../shared/catalogTransfer";
import { canAccessCustomerOps, canAccessSystemModules, isSuperadminRole, normalizeAppRole, type AppRole } from "../shared/roles";

const DashboardPage = lazy(() => import("../presentation/pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const InventoryPage = lazy(() => import("../presentation/pages/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const ItemsPage = lazy(() => import("../presentation/pages/ItemsPage").then((module) => ({ default: module.ItemsPage })));
const LoginPage = lazy(() => import("../presentation/pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const PortalPage = lazy(() => import("../presentation/pages/PortalPage").then((module) => ({ default: module.PortalPage })));
const PurchasesPage = lazy(() => import("../presentation/pages/PurchasesPage").then((module) => ({ default: module.PurchasesPage })));
const ReportsPage = lazy(() => import("../presentation/pages/ReportsPage").then((module) => ({ default: module.ReportsPage })));
const SalesPage = lazy(() => import("../presentation/pages/SalesPage").then((module) => ({ default: module.SalesPage })));
const SettingsPage = lazy(() => import("../presentation/pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

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
  if (canAccessCustomerOps(role)) {
    return allNavItems.filter((item) => item.key === "Home" || item.key === "Sales" || item.key === "Settings");
  }
  return allNavItems.filter((item) => item.key === "Home" || item.key === "Settings");
}

function getSalesSubNav(role: AppRole) {
  if (!canAccessCustomerOps(role)) return [] as const;
  return salesSubNav.filter((item) => item.key !== "Price Lists" || isSuperadminRole(role));
}

function getSettingsSubNav(role: AppRole) {
  if (isSuperadminRole(role)) return settingsSubNav;
  if (canAccessCustomerOps(role)) {
    return settingsSubNav.filter((item) => item.key === "session" || item.key === "portals");
  }
  return settingsSubNav.filter((item) => item.key === "session");
}

function getDefaultPage(role: AppRole) {
  return canAccessCustomerOps(role) ? "Sales" : "Home";
}

export function App() {
  const isPortalRoute = typeof window !== "undefined" && window.location.pathname.startsWith("/portal");
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [appRole, setAppRole] = useState<AppRole>("");
  const [appRoleReady, setAppRoleReady] = useState(false);
  const [activePage, setActivePage] = useState("Home");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [selectedSalesOrderId, setSelectedSalesOrderId] = useState("");
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [selectedPurchaseOrderId, setSelectedPurchaseOrderId] = useState("");
  const [selectedBillId, setSelectedBillId] = useState("");
  const [salesOrdersNavTick, setSalesOrdersNavTick] = useState(0);
  const [salesInvoicesNavTick, setSalesInvoicesNavTick] = useState(0);
  const [itemsTab, setItemsTab] = useState<"Catalog" | "Code References">("Catalog");
  const [inventoryInitialTab, setInventoryInitialTab] = useState<"Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers">("Warehouses");
  const [inventorySelectedWarehouseId, setInventorySelectedWarehouseId] = useState("");
  const [inventoryStockSearch, setInventoryStockSearch] = useState("");
  const [salesTab, setSalesTab] = useState<"Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists">("Sales Orders");
  const [purchasesTab, setPurchasesTab] = useState<"Vendors" | "Purchase Orders" | "Bills" | "Payments Made">("Vendors");
  const [reportsTab, setReportsTab] = useState<"Master" | "Item Transactions" | "Inventory Analytics">("Master");
  const [settingsTab, setSettingsTab] = useState<"session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics">("session");

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
      clearCachedAppSession();
      setAppRole("");
      setAppRoleReady(false);
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryMode(true);
        setLoggedIn(false);
        setSessionReady(true);
        return;
      }
      if (event === "SIGNED_OUT") {
        setRecoveryMode(false);
      }
      setLoggedIn(Boolean(session) && !recoveryMode);
      setSessionReady(true);
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
    setAppRoleReady(false);

    async function run() {
      try {
        const session = await fetchAppSession(true);
        if (cancelled) return;
        setAppRole(normalizeAppRole(session.role));
      } catch {
        if (!cancelled) {
          setAppRole("");
        }
      } finally {
        if (!cancelled) {
          setAppRoleReady(true);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [loggedIn, isPortalRoute]);

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
    }, 5 * 60 * 1000);

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

  function openSalesOrder(salesOrderId: string) {
    setSelectedSalesOrderId(salesOrderId);
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
    setSelectedPurchaseOrderId("");
    setSelectedBillId("");
    setSalesTab("Sales Orders");
    setActivePage("Sales");
  }

  function openPurchaseOrder(purchaseOrderId: string) {
    setSelectedPurchaseOrderId(purchaseOrderId);
    setSelectedBillId("");
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
    setPurchasesTab("Purchase Orders");
    setActivePage("Purchases");
  }

  function openInvoice(invoiceId: string) {
    setSelectedInvoiceId(invoiceId);
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedPurchaseOrderId("");
    setSelectedBillId("");
    setSalesTab("Invoices");
    setActivePage("Sales");
  }

  function openBill(billId: string) {
    setSelectedBillId(billId);
    setSelectedPurchaseOrderId("");
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
    setPurchasesTab("Bills");
    setActivePage("Purchases");
  }

  function openInventoryWarehouse(warehouseId: string) {
    setInventoryInitialTab("On Hand");
    setInventorySelectedWarehouseId(warehouseId);
    setInventoryStockSearch("");
    setActivePage("Inventory");
  }

  function openInventoryTab(tab: "Warehouses" | "On Hand") {
    setInventoryInitialTab(tab);
    setInventorySelectedWarehouseId("");
    setInventoryStockSearch("");
    setActivePage("Inventory");
  }

  function openInventoryItem(codeSearch: string, warehouseId?: string) {
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
    if (!allowedNavItems.some((item) => item.key === nextPage)) return;
    setActivePage(nextPage);
  }

  function handleSubNavigate(nextSubPage: string) {
    if (activePage === "Items" && itemSubNav.some((item) => item.key === nextSubPage)) {
      setItemsTab(nextSubPage as "Catalog" | "Code References");
      return;
    }
    if (activePage === "Inventory" && inventorySubNav.some((item) => item.key === nextSubPage)) {
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
      setPurchasesTab(nextSubPage as "Vendors" | "Purchase Orders" | "Bills" | "Payments Made");
      return;
    }
    if (activePage === "Reports" && reportsSubNav.some((item) => item.key === nextSubPage)) {
      setReportsTab(nextSubPage as "Master" | "Item Transactions" | "Inventory Analytics");
      return;
    }
    if (activePage === "Settings" && settingsSubNavItems.some((item) => item.key === nextSubPage)) {
      setSettingsTab(nextSubPage as "session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics");
    }
  }

  const salesSubNavItems = useMemo(() => getSalesSubNav(appRole), [appRole]);
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
      setSalesTab(salesSubNavItems[0].key as "Customers" | "Sales Orders" | "Invoices" | "Payments Received" | "Price Lists");
    }
  }, [salesSubNavItems, salesTab]);

  useEffect(() => {
    if (settingsSubNavItems.length && !settingsSubNavItems.some((item) => item.key === settingsTab)) {
      setSettingsTab(settingsSubNavItems[0].key as "session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics");
    }
  }, [settingsSubNavItems, settingsTab]);

  const subNavItems =
    activePage === "Items" && canAccessSystemModules(appRole)
      ? itemSubNav
      : activePage === "Inventory" && canAccessSystemModules(appRole)
        ? inventorySubNav
      : activePage === "Sales"
          ? salesSubNavItems
          : activePage === "Purchases" && canAccessSystemModules(appRole)
            ? purchasesSubNav
            : activePage === "Reports" && canAccessSystemModules(appRole)
              ? reportsSubNav
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
          <PortalPage />
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
    ) : activePage === "Inventory" && canAccessSystemModules(appRole) ? (
      <InventoryPage initialTab={inventoryInitialTab} selectedWarehouseId={inventorySelectedWarehouseId} stockSearch={inventoryStockSearch} />
    ) : activePage === "Sales" && canAccessCustomerOps(appRole) ? (
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
    ) : activePage === "Purchases" && canAccessSystemModules(appRole) ? (
      <PurchasesPage activeTab={purchasesTab} selectedPurchaseOrderId={selectedPurchaseOrderId} selectedBillId={selectedBillId} />
    ) : activePage === "Reports" && canAccessSystemModules(appRole) ? (
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
        navItems={allowedNavItems}
        subNavItems={subNavItems}
        onNavigate={handleMainNavigate}
        onNavigateSub={handleSubNavigate}
      >
        <Suspense fallback={renderPageFallback(`Loading ${activePage}...`)}>
          {pageContent}
        </Suspense>
      </AppShell>
    </ActionFeedbackProvider>
  );
}
