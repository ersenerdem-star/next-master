/**
 * Customer Desk v1 read-model contract.
 *
 * This is intentionally separate from PortalSnapshot. PortalSnapshot remains
 * the compatibility transport while the desk is migrated to a smaller,
 * customer-scoped read model. No admin or supplier-cost fields belong here.
 */

export type CustomerDeskMetricState = "available" | "not_available" | "not_evaluated";

export type CustomerDeskMetric<T> = {
  value: T | null;
  state: CustomerDeskMetricState;
  asOf?: string;
};
export type CustomerDeskRecommendationSource =
  | "customer_history"
  | "segment_aggregate"
  | "contract";

export type CustomerDeskSnapshot = {
  customer: {
    id: string;
    displayName: string;
  };
  search: {
    available: boolean;
    brands: string[];
  };
  account: {
    openAmount: CustomerDeskMetric<number>;
    dueSoonAmount: CustomerDeskMetric<number>;
    availableCredit: CustomerDeskMetric<number>;
    currency: string;
  };
  recentOrders: Array<{
    id: string;
    orderNo: string;
    status: string;
    total: number;
    currency: string;
    updatedAt: string;
  }>;
  recommendations: Array<{
    productCode: string;
    brand: string;
    reason: string;
    source: CustomerDeskRecommendationSource;
    price: CustomerDeskMetric<number>;
  }>;
};
