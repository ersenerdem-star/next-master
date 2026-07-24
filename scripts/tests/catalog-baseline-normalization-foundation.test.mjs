import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(new URL("../../supabase/migrations/20260511_item_code_references.sql", import.meta.url), "utf8");

test("baseline defines normalize_part_code before generated code references use it", () => {
  const definition = migration.indexOf("create or replace function public.normalize_part_code(input text)");
  const generatedReference = migration.indexOf("public.normalize_part_code(old_code)");
  assert.ok(definition >= 0, "baseline normalizer must be defined");
  assert.ok(generatedReference > definition, "generated expression must follow normalizer definition");
  assert.match(migration, /returns text\s+language sql\s+immutable\s+set search_path = public/i);
  assert.match(migration, /regexp_replace\(upper\(coalesce\(input, ''\)\), '\[\^A-Z0-9\]', '', 'g'\)/i);
});
