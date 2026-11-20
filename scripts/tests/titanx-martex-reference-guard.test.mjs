import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('Martex reference guard stages exact evidence and protects catalog fields and prices', async () => {
  const db = new PGlite();
  try {
    const fixture = await readFile(new URL('./titanx-martex-reference/fixture.sql', import.meta.url), 'utf8');
    const sql = await readFile(new URL('../../supabase/migrations/20261120135324_catalog_martex_titanx_reference_guard.sql', import.meta.url), 'utf8');
    const checks = await readFile(new URL('./titanx-martex-reference/test.sql', import.meta.url), 'utf8');
    await db.exec(fixture);
    await db.exec(sql);
    await db.exec(checks);
    const data = await db.query("select count(*)::integer as n from public.catalog_martex_reference_events_v2");
    assert.equal(data.rows[0].n, 2);
  } finally {
    await db.close();
  }
});
