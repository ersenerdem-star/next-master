import { useState } from "react";
import { CatalogPage } from "./CatalogPage";
import { CodeReferencesPage } from "./CodeReferencesPage";

export function ItemsPage() {
  const [activeTab, setActiveTab] = useState("Catalog");

  return (
    <div className="page-stack">
      <div className="module-tabs">
        <button className={`module-tab${activeTab === "Catalog" ? " active" : ""}`} onClick={() => setActiveTab("Catalog")}>
          Catalog
        </button>
        <button className={`module-tab${activeTab === "Code References" ? " active" : ""}`} onClick={() => setActiveTab("Code References")}>
          Code References
        </button>
      </div>
      {activeTab === "Catalog" ? <CatalogPage /> : null}
      {activeTab === "Code References" ? <CodeReferencesPage /> : null}
    </div>
  );
}
