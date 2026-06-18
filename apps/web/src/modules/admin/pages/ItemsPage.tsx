import { CatalogPage } from "./CatalogPage";
import { CodeReferencesPage } from "./CodeReferencesPage";

type ItemsPageProps = {
  activeTab?: "Catalog" | "Code References";
};

export function ItemsPage({ activeTab = "Catalog" }: ItemsPageProps) {
  return (
    <div className="page-stack">
      {activeTab === "Catalog" ? <CatalogPage /> : null}
      {activeTab === "Code References" ? <CodeReferencesPage /> : null}
    </div>
  );
}
