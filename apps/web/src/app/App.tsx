import { Suspense, lazy, useEffect, useState } from "react";
import { supabaseClient } from "../infrastructure/api/supabaseClient";
import { ActionFeedbackProvider } from "../presentation/components/common/ActionFeedback";
import { AppShell } from "../presentation/layout/AppShell";

const DashboardPage = lazy(() => import("../presentation/pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const InventoryPage = lazy(() => import("../presentation/pages/InventoryPage").then((module) => ({ default: module.InventoryPage })));
const ItemsPage = lazy(() => import("../presentation/pages/ItemsPage").then((module) => ({ default: module.ItemsPage })));
const LoginPage = lazy(() => import("../presentation/pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const PortalPage = lazy(() => import("../presentation/pages/PortalPage").then((module) => ({ default: module.PortalPage })));
const PurchasesPage = lazy(() => import("../presentation/pages/PurchasesPage").then((module) => ({ default: module.PurchasesPage })));
const ReportsPage = lazy(() => import("../presentation/pages/ReportsPage").then((module) => ({ default: module.ReportsPage })));
const SalesPage = lazy(() => import("../presentation/pages/SalesPage").then((module) => ({ default: module.SalesPage })));
const SettingsPage = lazy(() => import("../presentation/pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

export function App() {
  const isPortalRoute = typeof window !== "undefined" && window.location.pathname.startsWith("/portal");
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [activePage, setActivePage] = useState("Home");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [selectedSalesOrderId, setSelectedSalesOrderId] = useState("");
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [selectedPurchaseOrderId, setSelectedPurchaseOrderId] = useState("");
  const [selectedBillId, setSelectedBillId] = useState("");
  const [inventoryInitialTab, setInventoryInitialTab] = useState<"Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers">("Warehouses");
  const [inventorySelectedWarehouseId, setInventorySelectedWarehouseId] = useState("");
  const [inventoryStockSearch, setInventoryStockSearch] = useState("");
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
    setActivePage("Sales");
  }

  function openPurchaseOrder(purchaseOrderId: string) {
    setSelectedPurchaseOrderId(purchaseOrderId);
    setSelectedBillId("");
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
    setActivePage("Purchases");
  }

  function openInvoice(invoiceId: string) {
    setSelectedInvoiceId(invoiceId);
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedPurchaseOrderId("");
    setSelectedBillId("");
    setActivePage("Sales");
  }

  function openBill(billId: string) {
    setSelectedBillId(billId);
    setSelectedPurchaseOrderId("");
    setSelectedSalesOrderId("");
    setSelectedQuoteId("");
    setSelectedInvoiceId("");
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

  const pageContent =
    activePage === "Items" ? (
      <ItemsPage />
    ) : activePage === "Inventory" ? (
      <InventoryPage initialTab={inventoryInitialTab} selectedWarehouseId={inventorySelectedWarehouseId} stockSearch={inventoryStockSearch} />
    ) : activePage === "Sales" ? (
      <SalesPage
        selectedSalesOrderId={selectedSalesOrderId}
        onSelectedSalesOrderChange={setSelectedSalesOrderId}
        selectedQuoteId={selectedQuoteId}
        onSelectedQuoteChange={setSelectedQuoteId}
        selectedInvoiceId={selectedInvoiceId}
      />
    ) : activePage === "Purchases" ? (
      <PurchasesPage selectedPurchaseOrderId={selectedPurchaseOrderId} selectedBillId={selectedBillId} />
    ) : activePage === "Reports" ? (
      <ReportsPage
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
      <DashboardPage onOpenSalesOrder={openSalesOrder} onOpenInventoryTab={openInventoryTab} />
    );

  return (
    <ActionFeedbackProvider>
      <AppShell activePage={activePage} onNavigate={setActivePage}>
        <Suspense fallback={renderPageFallback(`Loading ${activePage}...`)}>
          {pageContent}
        </Suspense>
      </AppShell>
    </ActionFeedbackProvider>
  );
}
