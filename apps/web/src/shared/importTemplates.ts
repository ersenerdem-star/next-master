import { downloadCsv, toCsv } from "./csv";

export function downloadCatalogTemplate() {
  downloadCsv(
    "catalog-import-template.csv",
    toCsv([
      ["Product_Code", "Brand", "Product_Name", "OEM_No", "Vehicle", "HS_Code", "Origin", "Market_Segment", "Weight_kg"],
      ["0986332404", "Bosch", "Starter", "1519524", "Mercedes-Benz, MAN", "851140", "HU", "pc", "3.142"],
    ]),
  );
}

export function downloadCatalogLifecycleTemplate() {
  downloadCsv(
    "catalog-lifecycle-import-template.csv",
    toCsv([
      ["Product_Code", "Brand", "Lifecycle_Status", "Lifecycle_Note"],
      ["0986332404", "Bosch", "discontinued", "Production ended"],
      ["0433175575", "Bosch", "discontinued", "Use replacement code if available"],
    ]),
  );
}

export function downloadSupplierTemplate() {
  downloadCsv(
    "supplier-import-template.csv",
    toCsv([
      ["Product_Code", "Brand", "Product_Name", "OEM_No", "Buy_Price_EUR", "Price_Date", "MOQ", "Lead_Time_Days", "Notes"],
      ["0986332404", "Bosch", "Starter", "1519524", "52.43", "2026-05-11", "1", "7", "Sample row"],
    ]),
  );
}

export function downloadCodeReferenceTemplate() {
  downloadCsv(
    "code-references-template.csv",
    toCsv([
      ["Brand", "Old_Code", "New_Code", "Original_Number", "Reason", "Active"],
      ["Bosch", "0332209204", "0986332403", "1519524", "Supplier changed / replacement code", "Yes"],
    ]),
  );
}

export function downloadCPriceListTemplate() {
  downloadCsv(
    "c-price-list-template.csv",
    toCsv([
      ["Product_Code", "C_Price"],
      ["0986332404", "79.90"],
    ]),
  );
}

export function downloadQuoteTemplate() {
  downloadCsv(
    "quote-import-template.csv",
    [
      "Part_No;Brand;Qty",
      "0986332404;Bosch;2",
      "500001810;LUK;1",
    ].join("\n"),
  );
}
