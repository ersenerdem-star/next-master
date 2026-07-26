import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const logoSource = readFileSync(
  new URL("../../apps/web/src/presentation/components/common/logoAssets.ts", import.meta.url),
  "utf8",
);
const productVisualSource = readFileSync(
  new URL("../../apps/web/src/presentation/components/common/ProductVisual.tsx", import.meta.url),
  "utf8",
);

test("Motorservice brands have explicit non-blank logo fallbacks", () => {
  assert.match(logoSource, /match: \/\\bbf\\b\/i, label: "BF", wordmark: "BF"/);
  assert.match(logoSource, /match: \/pierburg\/i, label: "Pierburg", wordmark: "PIERBURG"/);
  assert.match(logoSource, /match: \/\\btrw\\b\/i[\s\S]*?trw_logo\.png/);
});

test("missing and placeholder product images resolve through brand fallback", () => {
  assert.match(productVisualSource, /const logoAsset = resolveNamedLogo\(displayBrand\)/);
  assert.match(productVisualSource, /noimage/);
  assert.match(productVisualSource, /logoAsset \? <img/);
});
