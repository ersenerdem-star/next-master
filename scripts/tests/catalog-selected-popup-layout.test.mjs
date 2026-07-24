import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const page = readFileSync(new URL("../../apps/web/src/presentation/pages/CatalogPage.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");

test("Catalog selected item uses a bounded drawer instead of a draggable transform surface", () => {
  assert.match(page, /<aside className="catalog-selected-popup"/);
  assert.doesNotMatch(page, /<DraggableSurface className="catalog-selected-popup"/);
  assert.match(styles, /\.catalog-selected-popup \{[\s\S]*?bottom: 20px;/);
  assert.match(styles, /\.catalog-selected-popup \.workbench-detail-panel \{[\s\S]*?overflow-y: auto;/);
});

test("Catalog selected item remains centered and viewport-bounded at narrow widths", () => {
  assert.match(styles, /left: 50%;[\s\S]*?transform: translateX\(-50%\);[\s\S]*?width: min\(560px, calc\(100vw - 28px\)\);/);
  assert.match(styles, /top: 96px;[\s\S]*?bottom: 14px;/);
});
