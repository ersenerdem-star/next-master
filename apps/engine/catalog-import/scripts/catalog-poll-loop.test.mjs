import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { isTransientCatalogTransportError, readCatalogQueue, runCatalogPollLoop } from "../src/catalog-poll-loop.mjs";

const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

test("queue-read timeouts back off with a cap, recover without restart, and reset the backoff", async () => {
  const controller = new AbortController();
  const waits = [], events = [];
  let attempts = 0;
  await runCatalogPollLoop({
    signal: controller.signal, pollMs: 100, maxBackoffMs: 250, random: () => 0.5,
    poll: () => readCatalogQueue("sources", async () => {
      attempts += 1;
      if ([1, 2, 3, 5].includes(attempts)) throw timeout();
    }),
    log: (event) => events.push(event),
    wait: async (ms) => { waits.push(ms); if (waits.length === 6) controller.abort(); },
  });
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [100, 200, 250, 100, 100, 100]);
  assert.deepEqual(events.filter((event) => event.status === "queue-read-recovered").map((event) => event.failedPolls), [3, 1]);
  assert.equal(JSON.stringify(events).includes("The operation was aborted"), false);
});

test("jitter stays within its bounded delay and only transport failures qualify", async () => {
  for (const [random, expected] of [[0, 80], [1, 120]]) {
    const controller = new AbortController();
    await runCatalogPollLoop({ signal: controller.signal, pollMs: 100, random: () => random,
      poll: () => readCatalogQueue("finalization", async () => { throw new Error("CATALOG_SUPABASE_HTTP_503"); }),
      wait: async (ms) => { assert.equal(ms, expected); controller.abort(); },
    });
  }
  assert.equal(isTransientCatalogTransportError(timeout()), true);
  assert.equal(isTransientCatalogTransportError(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })), true);
  for (const error of [new Error("CATALOG_SUPABASE_HTTP_401"), new Error("CATALOG_STORAGE_LEASE_FENCE"), new Error("CATALOG_SOURCE_CHECKSUM_MISMATCH")]) {
    assert.equal(isTransientCatalogTransportError(error), false);
  }
});

test("mutation/workflow timeouts and non-transient read failures are never retried by the poll loop", async () => {
  for (const poll of [
    async () => { throw timeout(); },
    () => readCatalogQueue("sources", async () => { throw new Error("CATALOG_SUPABASE_HTTP_403"); }),
    async () => { throw new Error("CATALOG_SOURCE_CHECKSUM_MISMATCH"); },
  ]) {
    let waits = 0;
    await assert.rejects(runCatalogPollLoop({ poll, wait: async () => { waits += 1; } }));
    assert.equal(waits, 0);
  }
});

test("shutdown cancels an idle read without retry and cancels a pending backoff", async () => {
  const controller = new AbortController();
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const events = [];
  const running = runCatalogPollLoop({ signal: controller.signal,
    poll: (signal) => readCatalogQueue("sources", () => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started();
    }), { signal }),
    log: (event) => events.push(event),
  });
  await entered;
  controller.abort();
  await running;
  assert.deepEqual(events, []);

  const backoffController = new AbortController();
  let calls = 0;
  await runCatalogPollLoop({ signal: backoffController.signal,
    poll: () => { calls += 1; return readCatalogQueue("sources", async () => { throw timeout(); }); },
    wait: async (ms, value, options) => {
      setImmediate(() => backoffController.abort());
      await delay(ms, value, options);
    },
  });
  assert.equal(calls, 1);
});

// Load the real worker wiring with only DBOS replaced. No database/provider is
// contacted; the real queue reads and source failure/lease RPC paths execute.
let workflowFailure;
let startedWorkflowIds = [];
globalThis.__catalogPollTestDbos = {
  registerWorkflow: (fn) => fn,
  getWorkflowStatus: async () => undefined,
  startWorkflow: (_workflow, options) => async () => {
    startedWorkflowIds.push(options.workflowID);
    return { getResult: async () => { if (workflowFailure) throw workflowFailure; return { processedRows: 3 }; } };
  },
};
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, nextResolve) {
    if (specifier === "@dbos-inc/dbos-sdk") return { shortCircuit: true, url: "data:text/javascript,export const DBOS=globalThis.__catalogPollTestDbos" };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);
const { pollCatalogImportSources, pollCatalogFinalization, catalogWorkflowId, configureCatalogRecoveryQueue, requireCatalogReadCompletionContract } = await import("../src/worker.mjs");
delete globalThis.__catalogPollTestDbos;

test("DBOS recovery queue is capped before launch so imports resume one at a time", () => {
  const queue = configureCatalogRecoveryQueue();
  assert.equal(queue.name, "_dbos_internal_queue");
  assert.equal(queue.concurrency, 1);
  assert.equal(queue.workerConcurrency, 1);
});

test("actual source and finalization discovery GET timeouts retry, with no mutation RPC", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const poll of [pollCatalogImportSources, pollCatalogFinalization]) {
      const controller = new AbortController();
      let reads = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(init.method, undefined);
        assert.ok(init.signal instanceof AbortSignal);
        reads += 1;
        if (reads === 1) throw timeout();
        return Response.json([]);
      };
      await runCatalogPollLoop({ signal: controller.signal, poll: (signal) => poll({ signal }),
        wait: async () => { if (reads === 2) controller.abort(); },
      });
      assert.equal(reads, 2);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("a retry uses the SQL lease generation even when the claim has no attempt_count", async () => {
  assert.notEqual(catalogWorkflowId({ run_id: "r", lease_generation: 1 }), catalogWorkflowId({ run_id: "r", lease_generation: 2 }));
  assert.throws(() => catalogWorkflowId({ run_id: "r", attempt_count: 5 }), /LEASE_CONTEXT_REQUIRED/);
  const originalFetch = globalThis.fetch;
  const source = { id: "source-retry", run_id: "run-retry", organization_id: "org", created_by: "actor" };
  const mutations = [];
  let generation = 0;
  startedWorkflowIds = [];
  try {
    globalThis.fetch = async (url, init) => {
      const path = new URL(url, "https://test.invalid").pathname;
      if (path.endsWith("/catalog_import_sources")) return Response.json([source]);
      if (path.endsWith("/catalog_import_runs")) return Response.json([{ id: source.run_id, status: "running", processing_queued_at: "2026-10-14", input_scope: {} }]);
      const args = JSON.parse(init.body);
      mutations.push({ path, args });
      if (path.endsWith("/claim_catalog_import_storage_source_system")) return Response.json({ claimed: true,
        source_id: source.id, run_id: source.run_id, organization_id: source.organization_id, created_by: source.created_by,
        lease_owner: "worker", lease_token: `token-${++generation}`, lease_generation: generation });
      assert.ok(path.endsWith("/release_catalog_import_storage_source_system"));
      return Response.json({ released: true });
    };
    workflowFailure = timeout();
    assert.equal((await pollCatalogImportSources())[0].status, "failed");
    workflowFailure = undefined;
    assert.equal((await pollCatalogImportSources())[0].status, "started");
    assert.deepEqual(startedWorkflowIds, ["catalog-storage:run-retry:lease-1", "catalog-storage:run-retry:lease-2"]);
    assert.equal(mutations.filter(({ path }) => path.endsWith("/release_catalog_import_storage_source_system")).length, 1);
  } finally { globalThis.fetch = originalFetch; workflowFailure = undefined; }
});

test("shutdown winning a successful queue response prevents new source or finalization work", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const poll of [pollCatalogImportSources, pollCatalogFinalization]) {
      const controller = new AbortController();
      let reads = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(init.method, undefined);
        reads += 1;
        controller.abort();
        return Response.json([{ id: "queued-work", run_id: "run-1", status: "staged" }]);
      };
      await runCatalogPollLoop({ signal: controller.signal, poll: (signal) => poll({ signal }),
        wait: async () => { throw new Error("must stop without waiting"); },
      });
      assert.equal(reads, 1);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("active workflow timeout releases its exact durable lease; invalid source fails without becoming an idle-read retry", async () => {
  const originalFetch = globalThis.fetch;
  const source = { id: "source-1", run_id: "run-1", organization_id: "org-1", created_by: "actor-1" };
  const claim = { claimed: true, source_id: source.id, run_id: source.run_id, organization_id: source.organization_id,
    created_by: source.created_by, lease_owner: "worker-1", lease_token: "lease-1", lease_generation: 7, attempt_count: 2 };
  try {
    for (const [failure, expected] of [[timeout(), "release"], [new Error("CATALOG_STORAGE_SOURCE_NOT_READY"), "release"], [new Error("CATALOG_SOURCE_CHECKSUM_MISMATCH"), "fail"]]) {
      workflowFailure = failure;
      const mutations = [];
      globalThis.fetch = async (url, init) => {
        const path = new URL(url, "https://test.invalid").pathname;
        if (path === "/rest/v1/catalog_import_sources") return Response.json([source]);
        if (path === "/rest/v1/catalog_import_runs") return Response.json([{ id: "run-1", status: "running", processing_queued_at: "2026-10-14", input_scope: {} }]);
        const args = JSON.parse(init.body);
        mutations.push({ path, args });
        if (path.endsWith("/claim_catalog_import_storage_source_system")) return Response.json(claim);
        assert.ok(path.endsWith(`/${expected}_catalog_import_storage_source_system`));
        return Response.json({ status: expected === "release" ? "uploaded" : "failed" });
      };
      const result = await pollCatalogImportSources();
      assert.equal(result[0].status, "failed");
      assert.equal(mutations.length, 2);
      assert.deepEqual([mutations[1].args.input_source_id, mutations[1].args.input_worker_id,
        mutations[1].args.input_lease_token, mutations[1].args.input_lease_generation], ["source-1", "worker-1", "lease-1", 7]);
    }
  } finally { globalThis.fetch = originalFetch; }
});

const finalizationRun = { id: 'run-ready', organization_id: 'org-ready', created_by: 'actor-ready',
  status: 'running', processing_queued_at: '2026-10-14T20:00:00Z', input_scope: { source_kind: 'storage_csv', source_id: 'source-ready' } };
const readySource = { id: 'source-ready', run_id: 'run-ready', organization_id: 'org-ready', created_by: 'actor-ready',
  status: 'staged', cursor_row: 2500, rows_parsed: 2501, rows_staged: 2501,
  read_complete_rows: 2501, read_completed_at: '2026-10-14T20:00:00Z' };

function finalizationFetch({ runs = [finalizationRun], source = readySource, sourceForRun, calls }) {
  return async (rawUrl, init) => {
    const url = new URL(rawUrl, 'https://test.invalid');
    if (!init.method) {
      if (url.pathname.endsWith('/catalog_import_runs')) return Response.json(runs);
      if (url.pathname.endsWith('/catalog_import_sources')) {
        const selected = sourceForRun ? sourceForRun(url.searchParams.get('run_id').slice(3)) : source;
        return Response.json(selected ? [selected] : []);
      }
      throw Error('UNEXPECTED_READ');
    }
    calls.push({ path: url.pathname, args: JSON.parse(init.body) });
    if (url.pathname.endsWith('/validate_catalog_import_storage_batch_system')) return Response.json({ status: 'validated' });
    if (url.pathname.endsWith('/finalize_catalog_import_batch_system')) return Response.json({ status: 'finalized', has_more: false });
    if (url.pathname.endsWith('/catalog_import_runs') && init.method === 'PATCH') return new Response(null, { status: 204 });
    throw Error('UNEXPECTED_MUTATION');
  };
}

test('restarted polling never validates a queued source until the full-file durable EOF receipt exists', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const cases = [
      { ...readySource, status: 'processing', cursor_row: 86, rows_parsed: 87, rows_staged: 87, read_complete_rows: null, read_completed_at: null },
      { ...readySource, read_complete_rows: null, read_completed_at: null },
      { ...readySource, read_complete_rows: 2500 },
      { ...readySource, rows_staged: 87 },
      { ...readySource, read_completed_at: 'invalid' },
      { ...readySource, created_by: 'other-actor' },
      null,
    ];
    for (const source of cases) {
      const calls = [];
      globalThis.fetch = finalizationFetch({ source, calls });
      assert.deepEqual(await pollCatalogFinalization(), { runId: finalizationRun.id, status: 'awaiting-source-completion' });
      assert.deepEqual(calls, [], 'no validation/finalization/queue-marker mutation while ingestion is incomplete');
    }
    const calls = [];
    globalThis.fetch = finalizationFetch({ calls });
    assert.equal((await pollCatalogFinalization()).status, 'finalized');
    assert.deepEqual(calls.map(x => x.path.split('/').at(-1)), [
      'validate_catalog_import_storage_batch_system', 'finalize_catalog_import_batch_system', 'catalog_import_runs',
    ]);
  } finally { globalThis.fetch = originalFetch; }
});

test('a busy oldest source does not block a ready candidate; source-less browser imports retain finalization', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const browserRun = { ...finalizationRun, id: 'browser-run', input_scope: { source_kind: 'browser' } };
    const calls = [];
    globalThis.fetch = finalizationFetch({ runs: [finalizationRun, browserRun], calls,
      sourceForRun: id => id === finalizationRun.id ? { ...readySource, status: 'processing' } : null });
    assert.deepEqual(await pollCatalogFinalization(), { runId: browserRun.id, status: 'finalized', hasMore: false });
    assert.equal(calls.length, 3);
    assert.ok(calls.slice(0, 2).every(x => x.args.input_run_id === browserRun.id));
  } finally { globalThis.fetch = originalFetch; }
});

test('source readiness transport error or cancellation cannot proceed to a mutation', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let reads = 0;
      globalThis.fetch = async (_url, init) => {
        assert.equal(init.method, undefined);
        reads++;
        if (reads === 1) return Response.json([finalizationRun]);
        if (!cancel) throw timeout();
        controller.abort();
        return Response.json([readySource]);
      };
      if (cancel) await assert.rejects(pollCatalogFinalization({ signal: controller.signal }), /abort/i);
      else await assert.rejects(pollCatalogFinalization(), /CATALOG_QUEUE_READ_TEMPORARILY_UNAVAILABLE/);
      assert.equal(reads, 2);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('startup requires the exact all-null EOF contract rejection before recovery or intake', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, body, passes] of [
      [400, { code: 'P0001', message: 'CATALOG_STORAGE_READ_INPUT_INVALID' }, true],
      [404, { code: 'PGRST202' }, false],
      [400, { code: 'other', message: 'CATALOG_STORAGE_READ_INPUT_INVALID' }, false],
      [200, { queued: true }, false],
    ]) {
      const probed = [];
      globalThis.fetch = async (url, init) => {
        assert.match(String(url), /\/rpc\/(complete_catalog_import_storage_read_system|get_catalog_import_storage_read_completion_system)$/);
        probed.push(String(url).split('/').at(-1));
        const args = JSON.parse(init.body);
        assert.equal(Object.keys(args).length, String(url).includes('/rpc/get_') ? 6 : 7);
        assert.ok(Object.values(args).every(x => x === null));
        return Response.json(body, { status });
      };
      if (passes) {
        await requireCatalogReadCompletionContract();
        assert.deepEqual(probed, ['complete_catalog_import_storage_read_system', 'get_catalog_import_storage_read_completion_system']);
      }
      else await assert.rejects(requireCatalogReadCompletionContract(), /CATALOG_STORAGE_READ_CONTRACT_UNAVAILABLE/);
    }
  } finally { globalThis.fetch = originalFetch; }
});
