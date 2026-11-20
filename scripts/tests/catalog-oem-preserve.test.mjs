import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCatalogOemNumbers as web, changedCatalogOemValue } from '../../apps/web/src/domain/shared/normalize.ts';
import { sanitizeCatalogOemNumbers as functionRoot } from '../../netlify/functions/_shared/catalog-standardization.mts';
import { sanitizeCatalogOemNumbers as functionCatalog } from '../../netlify/functions/_shared/catalog/catalog-standardization.mts';

for (const [name, sanitize] of [['web', web], ['functions root', functionRoot], ['functions catalog', functionCatalog]]) {
  test(`${name}: OEM identifiers keep letters, zeroes and punctuation`, () => {
    assert.equal(sanitize('0018308708, A0018308708'), '0018308708, A0018308708');
    assert.equal(sanitize('AB-012.003; AB012003 | 1234-5678'), 'AB-012.003, AB012003, 1234-5678');
    assert.equal(sanitize('A 007 603 01 41 06\n0000032'), 'A 007 603 01 41 06, 0000032');
    assert.equal(sanitize('ABCDEF'), 'ABCDEF');
    assert.equal(sanitize('A001, A001; a001'), 'A001, a001');
    assert.equal(sanitize(' -, N/A, null, NONE'), '');
  });
}

test('Unchanged OEM display fallback is not written during other catalog edits', () => {
  const displayed = '0018308708, A0018308708';
  assert.equal(changedCatalogOemValue(displayed, displayed), undefined);
  assert.equal(changedCatalogOemValue(displayed, 'A0018308708'), 'A0018308708');
  assert.equal(changedCatalogOemValue(displayed, ''), null);
  assert.equal(changedCatalogOemValue(null, ''), undefined);
});
