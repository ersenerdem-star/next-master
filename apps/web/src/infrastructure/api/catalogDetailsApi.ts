import { callAppRpc } from "./appRpcApi";
import type { CatalogProductDetails } from "../../types/catalogDetails";

export function fetchCatalogProductDetails(productId: string) {
  return callAppRpc<CatalogProductDetails>("get_catalog_product_details", {
    product_id: productId,
  });
}
