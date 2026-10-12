import { buildWorkbookBytes } from "./xlsxCore";

self.onmessage = ({ data }) => {
  try {
    const buffer = buildWorkbookBytes(data.sheetName, data.rows, data.numericColumns, data.options);
    self.postMessage({ buffer }, { transfer: [buffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Excel export failed." });
  }
};
