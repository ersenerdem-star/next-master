import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { previewQuantityPriceList } from './quantity-price-preview.mjs';

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

// The original supplier file remains evidence. The verified base file has
// one row per product, so current list readers still show the one-unit price.
export async function prepareSupplierQuantityRelease(bytes, sourceDate) {
  const header = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
  if (header.split(';').map(cell => cell.trim().toLowerCase()).join(';') !== 'product_code;moq;buy_price_eur') {
    throw new Error('QUANTITY_TIERS_UNSUPPORTED_COLUMNS');
  }
  const preview = await previewQuantityPriceList(Readable.from([bytes]), { sourceDate });
  if (preview.issues.length || !preview.tieredProductCount) {
    throw new Error('QUANTITY_TIERS_SOURCE_VALIDATION_BLOCKED');
  }
  const baseLines = ['Product_Code;MOQ;Buy_Price_Eur'];
  const rows = [];
  for (const product of preview.items) {
    const base = product.tiers[0];
    if (product.currency !== 'EUR' || base.minQuantity !== 1 ||
      product.tiers.some(tier => tier.validFrom !== sourceDate ||
        tier.validTo !== null || tier.availableQuantity !== null || (tier.orderMultiple ?? 1) !== 1)) {
      throw new Error('QUANTITY_TIERS_UNSUPPORTED_TERMS');
    }
    const codeCell = '"' + product.code.replaceAll('"', '""') + '"';
    baseLines.push(codeCell + ';1;' + String(base.unitPrice).replace('.', ','));
    for (const tier of product.tiers) {
      rows.push({
        code: product.code,
        quantity: tier.minQuantity,
        price: tier.unitPrice,
        source_row: tier.sourceRow,
      });
    }
  }
  rows.sort((a, b) => a.source_row - b.source_row);
  const baseCsv = Buffer.from(baseLines.join('\n') + '\n','utf8');
  return { baseCsv, baseSha256:checksum(baseCsv), originalSha256:checksum(bytes), rows };
}
