import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveNamedLogo } from "../../apps/web/src/presentation/components/common/logoAssets.ts";

test("TITANX resolves its own logo instead of the INA substring", () => {
  for (const brand of ["TITANX", "Titanx", "titanx"]) {
    assert.deepEqual(resolveNamedLogo(brand), {
      label: "TITANX",
      src: "/brand-logos/titanx_logo.png",
    });
  }
  assert.equal(resolveNamedLogo("INA").src, "/brand-logos/ina_logo.png");
});
