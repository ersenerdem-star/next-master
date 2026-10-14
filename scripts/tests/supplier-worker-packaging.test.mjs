import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';

const context = fileURLToPath(new URL('../../apps/engine/supplier-price-shadow/', import.meta.url));
const exec = promisify(execFile);

// Parse imports, re-exports and literal import()/require() calls, including
// transitive modules. A new runtime dependency must enter the Docker context.
async function runtimeClosure() {
  const pending = ['src/worker.mjs'], visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const absolute = resolve(context, path);
    const source = ts.createSourceFile(path, await readFile(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const imports = [];
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        imports.push(node.moduleSpecifier);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
        assert.ok(node.arguments.length && ts.isStringLiteralLike(node.arguments[0]),
          `${path}: computed module loading needs an explicit packaging contract`);
        imports.push(node.arguments[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      assert.ok(ts.isStringLiteralLike(specifier), `${path}: module specifier must be literal`);
      if (!specifier.text.startsWith('.')) continue;
      const target = relative(context, resolve(dirname(absolute), specifier.text));
      assert.ok(target.startsWith('src/') && !target.includes('..'), `${path}: dependency escapes runtime source: ${target}`);
      pending.push(target);
    }
  }
  return visited;
}

test('Docker allowlist contains the entire worker runtime import graph and no unrelated source', async (t) => {
  const lines = (await readFile(resolve(context, '.dockerignore'), 'utf8')).split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  // Deliberately support this strict allowlist grammar, not an approximation of
  // arbitrary Docker glob semantics. A broader rule must fail this check.
  assert.deepEqual(lines.slice(0, 5), ['*', '!package.json', '!package-lock.json', '!src/', 'src/**']);
  assert.ok(lines.slice(5).every(line => /^!src\/[a-z0-9-]+\.mjs$/.test(line)),
    'runtime files must be explicitly included after the blanket exclusions');
  const included = new Set(lines.slice(5).map(line => line.slice(1)));
  const closure = await runtimeClosure();
  assert.deepEqual([...closure].filter(path => !included.has(path)), [], 'runtime dependencies missing from Docker context');
  assert.deepEqual([...included].filter(path => !closure.has(path)), [], 'unreachable source must stay outside the worker image');
  t.diagnostic(`Verified ${closure.size} runtime modules reachable from src/worker.mjs`);
});

test('actual Docker image links the worker before failing closed without credentials',
  { skip: process.env.RUN_SUPPLIER_WORKER_DOCKER_TEST !== '1', timeout: 300_000 }, async () => {
  const image = `next-master-supplier-packaging-test:${process.pid}-${Date.now()}`;
  try {
    await exec('docker', ['build', '--tag', image, context], { timeout: 240_000, maxBuffer: 2 * 1024 * 1024 });
    let result;
    try {
      result = await exec('docker', ['run', '--rm', '--network', 'none', image], { timeout: 30_000 });
      assert.fail('unconfigured worker must refuse to start');
    } catch (error) {
      assert.equal(error.code, 1, 'worker must reach its configuration gate');
      result = error;
    }
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module/);
    assert.match(output, /SHADOW_PERSIST_STAGING_HOST_REQUIRED/);
    assert.match(output, /Supplier worker service stopped/);
  } finally {
    await exec('docker', ['image', 'rm', '--force', image], { timeout: 30_000 }).catch(() => {});
  }
});
