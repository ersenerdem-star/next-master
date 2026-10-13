// Synthetic six-row staging fixture, never a commercial price release.
export const RECOVERY_RELEASE_ID = "0f76bb63-deb1-4031-bbbc-11e19865c15f";
export const RECOVERY_SOURCE_PATH = "10000000-0000-0000-0000-000000000001/supplier-price/recovery-" + RECOVERY_RELEASE_ID + ".csv";
export const RECOVERY_SOURCE_DATE = "2026-10-01";
export const RECOVERY_SOURCE_CSV = "Product_Code,Brand,Buy_Price,Currency,Price_Date,Description\n" +
  Array.from({ length: 6 }, (_, index) => `RECOVERY-${RECOVERY_RELEASE_ID}-${index + 1},SHADOW-RECOVERY,${11 + index},EUR,2026-10-01,Recovery test row ${index + 1}\n`).join("");
export const RECOVERY_SOURCE_SHA256 = "ffcd3eb1a4b2f18d1e9e075149b961a760070d049605ef0a6af06b71d2a9a8c7";
