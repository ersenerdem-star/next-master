export const PREPARED_PRICE_VERSION_CONTRACT = 'publication-v1';

export function priceListVersionRpc(scope) {
  return scope?.versionContract === PREPARED_PRICE_VERSION_CONTRACT
    ? 'get_prepared_price_list_export_version'
    : 'get_admin_price_list_export_version';
}

export function preparedPortalPriceVersionInput(baseDataVersion, context) {
  return {
    baseDataVersion,
    customerId: context.customerId,
    priceListType: context.priceListType,
    currency: context.currency,
    effectiveMargin: context.priceListType === 'B' ? context.effectiveMarginB : context.effectiveMarginA,
  };
}
