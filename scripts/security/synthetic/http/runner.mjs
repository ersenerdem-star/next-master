// Local-only HTTP harness for the synthetic security environment.
//
// The runner deliberately uses an explicit manifest instead of importing every
// file under tests/. Some files are authenticated experiments or metadata only;
// importing them without an approved fixture/session could issue unsafe
// requests or produce a false green result. The default executable contract in
// this phase is the unauthenticated route check. Authenticated contracts are
// opt-in through an explicit environment variable and remain fail-closed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertLocalAuthEnvironment } from "../auth/guard.mjs";
import { assertSyntheticRuntimeWithLifecycle } from "../require-runtime.mjs";
import {
  acquireRunLock,
  DEFAULT_RUN_LOCK_PATH,
  releaseRunLock,
} from "../run-lock.mjs";
import {
  LOCAL_ENV_MARKER,
  LOCAL_PROJECT_ID,
  loadLocalSecurityEnv,
  redactSensitive,
} from "../safety.mjs";
import {
  deriveSyntheticHttpPortalSecret,
  expectedHttpIdentity,
  HTTP_IDENTITY_PATH,
  HTTP_PORTAL_SECRET_CONTRACT,
  HTTP_PORTAL_SECRET_CONTRACT_ENV,
  validateHttpIdentity,
} from "./identity.mjs";

const ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const TEST_ROOT = path.join(ROOT, "scripts", "security", "synthetic", "http", "tests");
const TRACE_PRELOAD = path.join(ROOT, "scripts", "security", "synthetic", "adapter", "fetch-trace.mjs");
const DEFAULT_TIMEOUT_MS = 15_000;
const CHILD_KILL_GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 128 * 1024;
let activeChildProcess = null;
let activeParentSignal = null;
let activeParentKillTimer = null;
export const AUTH_OPT_IN_ENV = "SECURITY_HTTP_AUTH_ENABLED";
export const DEFAULT_HTTP_TEST_NAME = "unauthenticated";
export const ALL_EXECUTABLE_SELECTOR = "__all-executable__";
const CHILD_ENV_KEYS = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "NVM_DIR",
  "SECURITY_TEST_ENV", "SECURITY_TEST_MARKER", "SUPABASE_URL", "SUPABASE_PROJECT_REF",
  "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "PORTAL_SESSION_SECRET",
  "MIRA_BRIDGE_ENABLED", "MIRA_BRIDGE_HMAC_SECRET", "SYNTHETIC_RUN_LOCK_TOKEN", AUTH_OPT_IN_ENV,
  HTTP_PORTAL_SECRET_CONTRACT_ENV,
]);

/**
 * Explicit test manifest. Authenticated entries require an explicit local
 * opt-in and a reviewed fixture/session adapter.
 */
export const HTTP_TESTS = Object.freeze([
  Object.freeze({
    name: "unauthenticated",
    file: "unauthenticated.mjs",
    mode: "unauthenticated",
    sec: ["SEC-002", "SEC-007", "SEC-008"],
  }),
  Object.freeze({
    name: "portal-session-order",
    file: "portal-session-order.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    nodeArgs: ["--import", "tsx"],
    sec: ["SEC-007"],
  }),
  Object.freeze({
    name: "portal-session-order-scope",
    file: "portal-session-order-scope.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    nodeArgs: ["--import", "tsx"],
    fixture: "portal:A:customer-A1 + temporary A2 orders",
    actor: "Organization A portal customer",
    writes: "temporary-sales-orders-and-audit-cleanup",
    sec: ["SEC-007"],
  }),
  Object.freeze({
    name: "portal-session-data",
    file: "portal-session-data.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    nodeArgs: ["--import", "tsx"],
    sec: ["SEC-002", "SEC-007", "SEC-008"],
  }),
  Object.freeze({
    name: "portal-session-account-permission",
    file: "portal-session-account-permission.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    nodeArgs: ["--import", "tsx"],
    fixture: "portal:A:customer-A1",
    actor: "Organization A portal customer",
    writes: "temporary-invite-permission-only",
    sec: ["SEC-007", "SEC-002"],
  }),
  Object.freeze({
    name: "portal-session-search",
    file: "portal-session-search.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    nodeArgs: ["--import", "tsx"],
    sec: ["SEC-008"],
  }),
  Object.freeze({
    name: "portal-session-prepare",
    file: "portal-session-prepare.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    nodeArgs: ["--import", "tsx"],
    fixture: "portal:A:customer-A1 + A/B catalog, supplier, pricing and code-reference projections",
    actor: "Organization A portal customer",
    writes: "temporary allowed_brand_ids scope + portal_order_prepare audit rows; restored and watermarked",
    sec: ["SEC-007", "SEC-008"],
  }),
  Object.freeze({
    name: "staff-session-customer",
    file: "staff-session-customer.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    fixture: "auth:A:sales",
    actor: "Organization A sales",
    writes: "temporary-customer-only",
    sec: ["SEC-006"],
  }),
  Object.freeze({
    name: "staff-session-lifecycle",
    file: "staff-session-lifecycle.mjs",
    mode: "authenticated",
    requiresExplicitOptIn: true,
    fixture: "auth:generated:A:sales",
    actor: "Organization A generated sales profile",
    writes: "temporary-auth-profile-only",
    sec: ["SEC-012"],
  }),
  Object.freeze({
    name: "critical-routes",
    file: "critical-routes.mjs",
    mode: "metadata",
    sec: ["SEC-005", "SEC-006", "SEC-014", "SEC-015"],
  }),
  Object.freeze({
    name: "critical-routes-contract",
    file: "critical-routes-contract.mjs",
    mode: "unauthenticated",
    sec: ["SEC-005", "SEC-006", "SEC-014", "SEC-015"],
  }),
]);

function isMain() {
  return process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

export function loopbackUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:") return null;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
    if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "")) return null;
    if (url.search || url.hash) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return `http://${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

function redact(value, env = process.env) {
  let output = redactSensitive(String(value || ""), Object.values(env || {}));
  // Replace exact values first, including arbitrary HMAC/SMTP secrets that do
  // not look like JWTs. No environment value is ever printed.
  for (const [name, raw] of Object.entries(env || {})) {
    const secret = String(raw || "");
    if (!/(key|secret|token|password|pass)/i.test(name) || secret.length < 8) continue;
    output = output.split(secret).join("[redacted]");
  }
  return output
    // Child output often contains JSON escaped inside a JSON string
    // (`\\"password\\":\\"...`). Accept both escaped and plain quotes.
    .replace(/(authorization|set-cookie|cookie|password|secret|service[_-]?role[_-]?key|anon[_-]?key|token)(?:\\?["']?)\s*[:=]\s*(?:\\?["']?)([^,}\]\n]+)/gi, "$1:[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[jwt-redacted]")
    .replace(/https?:\/\/[^\s"']+/gi, (url) => {
      try {
        const parsed = new URL(url);
        for (const key of ["apikey", "api_key", "token", "secret", "password", "key"]) {
          if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
        }
        return parsed.toString();
      } catch {
        return "[url-redacted]";
      }
    });
}

function childEnvironment(env, baseUrl, runLockToken = "") {
  const child = {};
  for (const key of CHILD_ENV_KEYS) {
    // A caller-controlled token must never be forwarded.  Only the lock
    // acquired by this runner can authorize a child against the shared
    // fixture.
    if (key === "SYNTHETIC_RUN_LOCK_TOKEN") continue;
    if (env[key] !== undefined && env[key] !== "") child[key] = env[key];
  }
  child.NETLIFY_LOCAL_URL = baseUrl;
  child.SECURITY_TEST_ENV = "1";
  child.SECURITY_TEST_MARKER = LOCAL_ENV_MARKER;
  // Bind every HTTP child to the same deterministic local portal secret as
  // the isolated Netlify launcher.  A caller-supplied value is checked before
  // this function is reached; the child receives only the derived value.
  const derivedPortalSecret = deriveSyntheticHttpPortalSecret({
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    marker: env.SECURITY_TEST_MARKER || LOCAL_ENV_MARKER,
  });
  if (derivedPortalSecret) {
    child.PORTAL_SESSION_SECRET = derivedPortalSecret;
    child[HTTP_PORTAL_SECRET_CONTRACT_ENV] = HTTP_PORTAL_SECRET_CONTRACT;
  }
  if (runLockToken) child.SYNTHETIC_RUN_LOCK_TOKEN = runLockToken;
  // Do not inherit arbitrary caller NODE_OPTIONS. The preload is the only
  // supported child hook and enforces the non-loopback network boundary in
  // every synthetic HTTP test process.
  child.NODE_OPTIONS = `--import=${TRACE_PRELOAD}`;
  return child;
}

export function authenticatedHttpOptedIn(env = process.env) {
  return String(env?.[AUTH_OPT_IN_ENV] || "").trim() === "1";
}

/**
 * Validate the optional caller-supplied portal secret without ever returning
 * or logging the secret.  A blank value is allowed here because the runner
 * derives the canonical value for its isolated child; an arbitrary supplied
 * value is refused instead of silently replacing it.
 */
export function syntheticHttpPortalSecretStatus(env = process.env) {
  const expected = deriveSyntheticHttpPortalSecret({
    serviceRoleKey: env?.SUPABASE_SERVICE_ROLE_KEY,
    marker: env?.SECURITY_TEST_MARKER || LOCAL_ENV_MARKER,
  });
  if (!expected) {
    return { ok: false, reason: "local service-role key is required for the HTTP portal secret binding" };
  }
  const supplied = String(env?.PORTAL_SESSION_SECRET || "").trim();
  if (supplied && supplied !== expected) {
    return { ok: false, reason: "PORTAL_SESSION_SECRET does not match the local service-role binding" };
  }
  return { ok: true, supplied: Boolean(supplied) };
}

/**
 * Extract an explicit terminal BLOCKED envelope from a child test.
 *
 * Some authenticated contracts cannot safely run until the disposable public
 * projection exposes every relation consumed by the real handler.  Such a
 * child must be reported as BLOCKED (rather than an unexplained FAIL or a
 * false PASS) while preserving the runner's bounded/redacted output policy.
 * Only a standalone final JSON object with an explicit no-request marker is
 * accepted; arbitrary response JSON cannot change the runner classification.
 */
export function parseBlockedEnvelope(output) {
  const lines = String(output || "").split(/\r?\n/);
  let terminalLine = -1;
  let value = null;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines[index].trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        terminalLine = index;
        value = parsed;
      }
    } catch {
      // Keep scanning; a malformed diagnostic cannot become a block.
    }
  }
  if (!value || value.status !== "BLOCKED" || value.syntheticOnly !== true) return null;
  if (typeof value.testId !== "string" || value.testId.trim() === "") return null;
  // A child may explicitly carry a recovery marker when it knows its fixture
  // is dirty. Never downgrade that marker to a harmless no-request block.
  if (value.fixtureRecoveryRequired === true) return null;
  // A terminal block is safe to classify as "no request" only when the
  // child explicitly says that no request was made.  A conclusion field
  // alone is insufficient: a child may have performed a request and then
  // reported BLOCKED after a partial failure. Requiring the last JSON record
  // also prevents an earlier block from hiding a later request/result.
  // A no-request envelope must be the final non-empty output.  A trace or
  // response line after it could prove that a request actually happened, so
  // classify that stream as recovery-required instead of trusting the block.
  if (lines.slice(terminalLine + 1).some((line) => line.trim())) return null;
  // The same rule applies before the envelope: a prior terminal JSON result or
  // a Netlify route trace proves that the child had already started a request.
  // Local Supabase fixture reads (`/rest/`/`/auth/`) are allowed because they
  // are preflight bookkeeping, but `/api/` and function routes are never
  // compatible with a no-request block.
  for (const line of lines.slice(0, terminalLine)) {
    const trimmed = line.trim();
    if (/\[security-trace\].*(?:\/api\/|\/\.netlify\/functions\/)/i.test(trimmed)) return null;
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const prior = JSON.parse(trimmed);
      if (prior && typeof prior === "object" && !Array.isArray(prior)
        && (prior.requestMade === true || typeof prior.status === "string")) return null;
    } catch {
      // A malformed prior record is not evidence of a safe no-request block.
      if (trimmed.startsWith("{")) return null;
    }
  }
  if (value.mutationStarted === true
    && !(value.cleanupStatus === "PASS" || value.fixtureRestored === true)) return null;
  return value.requestMade === false ? value : null;
}

/**
 * Require a concrete success record before treating an exit code of zero as
 * PASS.  An empty/malformed child output can otherwise produce a false green
 * result when a process exits early without running its assertions.
 */
function jsonRecords(output) {
  const lines = String(output || "").trim().split(/\r?\n/);
  let records = [];
  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
    } catch {
      // Diagnostic lines are ignored; a concrete JSON success record is still
      // required below.
    }
  }
  return records;
}

function cleanupPass(value) {
  return value?.cleanup === "PASS" || value?.cleanup?.status === "PASS";
}

function hasNegativeRecord(records) {
  return records.some((value) => (
    ["FAIL", "FINDINGS", "INCONCLUSIVE", "BLOCKED"].includes(value.status)
    || value.conclusion === "CONFIRMED_VULNERABLE"
  ));
}

function hasRequestTraceAfterLastJson(output) {
  const lines = String(output || "").split(/\r?\n/);
  let lastJson = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) lastJson = index;
    } catch {
      // Leave the last valid JSON position unchanged.
    }
  }
  if (lastJson < 0) return false;
  return lines.slice(lastJson + 1).some((line) =>
    /\[security-trace\]\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+/i.test(line)
    || /^Request from\s+/i.test(line.trim())
    || /^Response with status\s+/i.test(line.trim()));
}

/**
 * Validate the terminal shape emitted by one manifest entry.  Each
 * authenticated/mutating child has a primary result plus a cleanup proof;
 * accepting an arbitrary `status:PASS` line would allow truncated output to
 * become a false green result.
 */
export function hasPassEvidence(output, testName = "") {
  const records = jsonRecords(output);
  if (!records.length || hasNegativeRecord(records)) return false;
  if (hasRequestTraceAfterLastJson(output)) return false;
  const last = records.at(-1);
  switch (testName) {
    case "unauthenticated": {
      const expected = new Set(["portal-order-detail", "portal-price-list"]);
      const routes = records.filter((value) => typeof value.route === "string");
      return routes.length === expected.size
        && new Set(routes.map((value) => value.route)).size === expected.size
        && routes.every((value) => expected.has(value.route) && value.passed === true);
    }
    case "portal-session-order":
      return last?.status === "PASS"
        && last.sessionVerified === true
        && last.ownOrder?.allowed === true
        && last.foreignOrder?.denied === true
        && last.foreignIdDisclosed === false
        && cleanupPass(last);
    case "portal-session-search":
      return last?.status === "PASS"
        && Number(last.allowed) === 1
        && Number(last.denied) === 0
        && Array.isArray(last.foreignIds) && last.foreignIds.length === 0
        && Array.isArray(last.sensitiveKeys) && last.sensitiveKeys.length === 0
        && cleanupPass(last);
    case "portal-session-data":
      return last?.status === "PASS"
        && last.fixtureRestored === true
        && last.foreignTenantUnchanged === true
        && Number(last.auditEventsAdded) >= 4
        // The data contract now emits an explicit terminal cleanup record.
        // Treating that record as optional would let an early/truncated child
        // output retain a false PASS based only on its primary result.
        && last.cleanup?.status === "PASS";
    case "portal-session-account-permission": {
      const finding = records.find((value) => value.conclusion === "CONFIRMED_SAFE");
      return Boolean(finding)
        && last?.cleanup === "PASS"
        && last.fixtureRestored === true
        && last.databaseBeforeAfter === "MATCH"
        && Number(last.foreignTenantRowDiff) === 0;
    }
    case "portal-session-order-scope": {
      const finding = records.find((value) => value.testId && value.status === "PASS");
      return Boolean(finding)
        && finding.assertionFailed === false
        && last?.cleanup === "PASS"
        && last.databaseBeforeAfter === "MATCH"
        && Number(last.foreignTenantRowDiff) === 0;
    }
    case "portal-session-prepare": {
      const finding = records.find((value) => value.testId && value.status === "PASS");
      return Boolean(finding)
        && Array.isArray(finding.findings) && finding.findings.length === 0
        && last?.cleanup === "PASS"
        && last.databaseBeforeAfter === "MATCH"
        && Array.isArray(last.foreignTenantRowDiff) && last.foreignTenantRowDiff.length === 0
        && Number(last.auditRowsRemainingAfterCleanup) === 0;
    }
    case "staff-session-customer":
      return last?.status === "PASS"
        && cleanupPass(last)
        && last.cleanup?.databaseBeforeAfter === "MATCH"
        && Number(last.cleanup?.foreignTenantRowDiff) === 0;
    case "staff-session-lifecycle": {
      const finding = records.find((value) => value.testId && value.status === "PASS");
      return Boolean(finding)
        && finding.conclusion === "CONFIRMED_SAFE"
        && last?.cleanup?.status === "PASS"
        && last.cleanup.databaseBeforeAfter === "MATCH"
        && Number(last.cleanup.foreignTenantRowDiff) === 0;
    }
    default:
      return last?.status === "PASS" && cleanupPass(last);
  }
}

export function boundedAppend(state, chunk) {
  // Reaching the cap is itself insufficient evidence that the complete
  // terminal record was captured.  Fail closed at the exact boundary; any
  // output at or beyond the cap is treated as truncated and therefore cannot
  // produce a PASS result.
  if (state.bytes >= MAX_OUTPUT_BYTES) {
    state.truncated = true;
    return;
  }
  const text = String(chunk);
  const remaining = MAX_OUTPUT_BYTES - state.bytes;
  state.output += text.slice(0, remaining);
  state.bytes += Math.min(text.length, remaining);
  if (text.length > remaining || state.bytes >= MAX_OUTPUT_BYTES) state.truncated = true;
}

export function parseArgs(argv = []) {
  const args = [...argv];
  const options = { requested: null, list: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  while (args.length) {
    const arg = args.shift();
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--test" || arg === "--only") {
      options.requested = args.shift() || "";
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = Number(args.shift());
      if (!Number.isInteger(value) || value < 1_000 || value > 60_000) {
        throw new Error("--timeout-ms must be an integer between 1000 and 60000");
      }
      options.timeoutMs = value;
      continue;
    }
    if (arg === "--all") {
      // `--all` reports every manifest entry. It never bypasses the
      // authenticated/metadata block below.
      options.requested = "*";
      continue;
    }
    if (arg === "--all-executable") {
      // Explicitly select runnable entries while retaining metadata in the
      // returned manifest/report as an excluded, non-executable entry.
      options.requested = ALL_EXECUTABLE_SELECTOR;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function selectTests(options) {
  // A bare invocation is intentionally narrow: it runs the reviewed
  // unauthenticated contract only. Authenticated and metadata entries must
  // be selected explicitly (`--test`), included deliberately with `--all`,
  // or selected as runnable contracts with `--all-executable`.
  if (!options.requested) {
    const defaultTest = HTTP_TESTS.find((test) => test.name === DEFAULT_HTTP_TEST_NAME);
    if (!defaultTest) throw new Error(`Default HTTP test is missing: ${DEFAULT_HTTP_TEST_NAME}`);
    return [defaultTest];
  }
  if (options.requested === "*") return [...HTTP_TESTS];
  if (options.requested === ALL_EXECUTABLE_SELECTOR) {
    return HTTP_TESTS.filter((test) => test.mode !== "metadata");
  }
  const selected = HTTP_TESTS.filter((test) => test.name === options.requested);
  if (!selected.length) throw new Error(`Unknown HTTP test: ${options.requested}`);
  return selected;
}

function selectionDetails(options) {
  if (options.requested !== ALL_EXECUTABLE_SELECTOR) return {};
  return {
    selection: "all-executable",
    excludedMetadata: HTTP_TESTS
      .filter((test) => test.mode === "metadata")
      .map(({ name, mode, sec, file }) => ({
        name,
        mode,
        sec,
        file,
        requestMade: false,
        reason: "metadata-only entry is excluded; no request was made",
      })),
  };
}

async function readBoundedText(response, maxBytes = 16 * 1024) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= maxBytes ? text : null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5_000));
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchIdentityWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 5_000));
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { "x-next-master-security-probe": "1" },
      signal: controller.signal,
    });
    const body = await readBoundedText(response);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Prove that NETLIFY_LOCAL_URL is the disposable launcher created for this
 * repository.  `/version.txt` identifies Netlify Dev; the generated identity
 * function then binds the server to the exact local Supabase endpoint,
 * project marker, and service-role fingerprint expected by this process.
 */
export async function probeServer(baseUrl, timeoutMs, env = process.env) {
  try {
    const versionResponse = await fetchWithTimeout(`${baseUrl}/version.txt`, timeoutMs, {
      method: "GET",
      redirect: "error",
    });
    const server = versionResponse.headers.get("server") || "";
    const requestId = versionResponse.headers.get("x-nf-request-id") || versionResponse.headers.get("x-nf-invocation-metadata") || "";
    if (!versionResponse.ok || (!/netlify/i.test(server) && !requestId)) {
      return { ok: false, reason: "loopback endpoint is not a recognized Netlify Dev server" };
    }

    const { response: identityResponse, body: identityBody } = await fetchIdentityWithTimeout(
      `${baseUrl}${HTTP_IDENTITY_PATH}`,
      timeoutMs,
    );
    if (!identityResponse.ok) {
      return { ok: false, reason: "Netlify Dev identity handshake endpoint is unavailable" };
    }
    if (identityBody === null) {
      return { ok: false, reason: "Netlify Dev identity handshake response exceeded the safety limit" };
    }
    let identity;
    try {
      identity = JSON.parse(identityBody);
    } catch {
      return { ok: false, reason: "Netlify Dev identity handshake returned invalid JSON" };
    }
    const expected = expectedHttpIdentity({
      marker: env.SECURITY_TEST_MARKER || LOCAL_ENV_MARKER,
      supabaseUrl: env.SUPABASE_URL,
      projectRef: env.SUPABASE_PROJECT_REF || LOCAL_PROJECT_ID,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    const validation = validateHttpIdentity(identity, expected);
    if (!validation.ok) {
      return {
        ok: false,
        reason: "Netlify Dev identity handshake does not match the local synthetic runtime",
        identityReasons: validation.reasons,
      };
    }
    return { ok: true, identity: expected };
  } catch {
    return { ok: false, reason: "NETLIFY_LOCAL_URL is not reachable on loopback" };
  }
}

function runChild(test, baseUrl, timeoutMs, env, runLockToken = "") {
  return new Promise((resolve) => {
    const childPath = path.join(TEST_ROOT, test.file);
    if (!existsSync(childPath)) {
      resolve({ status: "BLOCKED", reason: "test file is missing", exitCode: null, output: "" });
      return;
    }
    const childArgs = test.nodeArgs ? [...test.nodeArgs, childPath] : [childPath];
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT,
      env: childEnvironment(env, baseUrl, runLockToken),
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildProcess = child;
    const state = { output: "", bytes: 0, truncated: false };
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give a child a bounded grace period to run its terminal fixture
      // restoration after SIGTERM.  The result remains blocked regardless;
      // the grace period only reduces the chance of leaving a temporary row
      // dirty before the operator performs the required reset.
      killTimer = setTimeout(() => child.kill("SIGKILL"), CHILD_KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => boundedAppend(state, chunk));
    child.stderr.on("data", (chunk) => boundedAppend(state, chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (activeParentKillTimer) {
        clearTimeout(activeParentKillTimer);
        activeParentKillTimer = null;
      }
      if (activeChildProcess === child) activeChildProcess = null;
      // The child object was created before this event. Treat its outcome as
      // potentially dirty; an authenticated child always requires an
      // explicit fixture reset even when the process failed to start cleanly.
      resolve({
        status: "BLOCKED",
        reason: "could not start test process; local fixture reset is required",
        exitCode: null,
        output: redact(error.message, env),
        requestMade: true,
        ...(test.mode === "authenticated" ? { fixtureRecoveryRequired: true } : {}),
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (activeParentKillTimer) {
        clearTimeout(activeParentKillTimer);
        activeParentKillTimer = null;
      }
      if (activeChildProcess === child) activeChildProcess = null;
      const output = redact(state.output, env);
      if (activeParentSignal) {
        resolve({
          status: "BLOCKED",
          reason: `parent process interrupted by ${activeParentSignal}; local fixture reset is required`,
          exitCode: code,
          signal,
          output,
          requestMade: true,
          fixtureRecoveryRequired: true,
        });
      } else if (timedOut) {
        resolve({
          status: "BLOCKED",
          reason: `test timed out after ${timeoutMs}ms; local fixture reset is required before another test`,
          exitCode: code,
          signal,
          output,
          timedOut: true,
          requestMade: true,
          fixtureRecoveryRequired: true,
        });
      } else if (state.truncated) {
        resolve({
          status: "BLOCKED",
          reason: "child output exceeded the bounded limit; local fixture reset is required",
          exitCode: code,
          signal,
          output,
          outputTruncated: true,
          requestMade: true,
          fixtureRecoveryRequired: true,
        });
      } else {
        const blockedEnvelope = parseBlockedEnvelope(output);
        if (blockedEnvelope) {
          const reason = redact(
            blockedEnvelope.reason || blockedEnvelope.actual || "child reported an explicit contract block",
            env,
          );
          resolve({ status: "BLOCKED", reason, exitCode: code, signal, output, requestMade: false });
        } else if (code === 0) {
          if (!hasPassEvidence(output, test.name)) {
            resolve({
              status: "BLOCKED",
              reason: "child exited successfully without a valid terminal PASS record; local fixture reset is required",
              exitCode: code,
              signal,
              output,
              requestMade: true,
              fixtureRecoveryRequired: true,
            });
          } else {
            resolve({ status: "PASS", reason: null, exitCode: code, signal, output, requestMade: true });
          }
        } else {
          resolve({
            status: "FAIL",
            reason: signal ? `test terminated by ${signal}` : `test exited with code ${code}`,
            exitCode: code,
            signal,
            output,
            requestMade: true,
            ...(test.mode === "authenticated" ? { fixtureRecoveryRequired: true } : {}),
          });
        }
      }
    });
  });
}

function blockedResult(test, reason, extra = {}) {
  return {
    name: test.name,
    sec: test.sec,
    mode: test.mode,
    status: "BLOCKED",
    reason,
    requestMade: false,
    optInRequired: Boolean(test.requiresExplicitOptIn),
    ...extra,
  };
}

export async function runHttpHarness({
  env = process.env,
  argv = process.argv.slice(2),
  allowUnitTestEnvironment = false,
} = {}) {
  // Keep env loading in the executable path only. Callers importing helpers
  // for unit tests do not get an implicit database/network operation.
  const executableEnvironment = env === process.env;
  if (executableEnvironment) loadLocalSecurityEnv({ env });
  const options = parseArgs(argv);
  if (options.list) {
    return {
      status: "READY",
      tests: HTTP_TESTS.map(({ name, mode, sec, file, requiresExplicitOptIn, fixture, actor, writes }) => ({
        name,
        mode,
        sec,
        file,
        requiresExplicitOptIn: Boolean(requiresExplicitOptIn),
        ...(fixture ? { fixture } : {}),
        ...(actor ? { actor } : {}),
        ...(writes ? { writes } : {}),
      })),
    };
  }

  // A cloned environment is deliberately refused by default.  Without this
  // guard a caller could copy process.env, bypass the strict lifecycle/DB
  // identity check, and still execute real loopback contracts.  The only
  // supported bypass is an explicit, side-effect-free unit-test contract.
  const unitTestEnvironment = env !== process.env
    && allowUnitTestEnvironment === true
    && env.NODE_ENV === "test"
    && env.SECURITY_HTTP_UNIT_TEST === "1";
  if (env !== process.env && !unitTestEnvironment) {
    throw new Error("HTTP harness refused: cloned environments require allowUnitTestEnvironment=true, NODE_ENV=test, and SECURITY_HTTP_UNIT_TEST=1");
  }

  // The CLI path must prove the exact disposable Docker/CLI/database identity
  // before probing Netlify. Imported unit tests use an explicit env object and
  // retain the lightweight marker check so they remain side-effect free.
  if (executableEnvironment) assertSyntheticRuntimeWithLifecycle({ env, requireMarker: true, verifyCli: true });
  if (String(env.SECURITY_TEST_MARKER || "").trim() !== LOCAL_ENV_MARKER) {
    throw new Error(`HTTP harness refused: SECURITY_TEST_MARKER must equal ${LOCAL_ENV_MARKER}`);
  }
  assertLocalAuthEnvironment(env);
  const baseUrl = loopbackUrl(env.NETLIFY_LOCAL_URL);
  if (!baseUrl) {
    return {
      status: "BLOCKED",
      tests: [],
      reason: "NETLIFY_LOCAL_URL must be an http://localhost:<port> or http://127.0.0.1:<port> URL",
      ...selectionDetails(options),
    };
  }
  const tests = selectTests(options);
  const probe = await probeServer(baseUrl, options.timeoutMs, env);
  if (!probe.ok) {
    return {
      status: "BLOCKED",
      baseUrl,
      tests: tests.map((test) => blockedResult(test, probe.reason)),
      reason: probe.reason,
      ...selectionDetails(options),
    };
  }

  // Authenticated HTTP contracts mutate a shared synthetic fixture.  Protect
  // standalone runs with the same atomic lock used by the aggregate runner;
  // otherwise two terminals could restore the same invite/customer rows at
  // the same time and invalidate both sets of evidence.  Unit-test calls use
  // a cloned environment and never acquire a real lock.
  const needsRunLock = executableEnvironment && tests.some((test) => test.mode === "authenticated");
  let runLock = null;
  if (needsRunLock) {
    try {
      runLock = acquireRunLock({ lockPath: DEFAULT_RUN_LOCK_PATH, repositoryRoot: ROOT });
    } catch (error) {
      const reason = redact(error?.message || error, env);
      return {
        status: "BLOCKED",
        baseUrl,
        tests: tests.map((test) => blockedResult(test, reason)),
        reason,
        ...selectionDetails(options),
      };
    }
  }

  let result;
  let lockReleaseFailed = false;
  try {
    const results = [];
    let fixtureRecoveryRequired = false;
    for (let index = 0; index < tests.length; index += 1) {
      const test = tests[index];
      if (activeParentSignal) {
        fixtureRecoveryRequired = true;
        for (const remaining of tests.slice(index)) {
          results.push(blockedResult(
            remaining,
            `parent process interrupted by ${activeParentSignal}; run security:synthetic:reset before continuing`,
            { fixtureRecoveryRequired: true },
          ));
        }
        break;
      }
      if (test.mode === "metadata") {
        results.push(blockedResult(test, "metadata entry is never executable; no request was made"));
        continue;
      }
      if (test.mode === "authenticated" && !authenticatedHttpOptedIn(env)) {
        results.push(blockedResult(test, `authenticated HTTP tests require explicit ${AUTH_OPT_IN_ENV}=1; no request was made`));
        continue;
      }
      if (test.mode === "authenticated") {
        const portalSecret = syntheticHttpPortalSecretStatus(env);
        if (!portalSecret.ok) {
          results.push(blockedResult(test, `${portalSecret.reason}; no request was made`));
          continue;
        }
      }
      if (unitTestEnvironment) {
        // Unit tests may exercise selection, probing, and preflight behavior but
        // must never spawn a real child against an arbitrary loopback service.
        results.push(blockedResult(test, "unit-test environment cannot execute HTTP child processes; use the strict process environment", { unitTestOnly: true }));
        continue;
      }
      const child = await runChild(test, baseUrl, options.timeoutMs, env, runLock?.token || "");
      const requestMade = child.requestMade ?? (child.status !== "BLOCKED");
      results.push({ name: test.name, sec: test.sec, mode: test.mode, requestMade, ...child });
      if (child.fixtureRecoveryRequired) {
        fixtureRecoveryRequired = true;
        // Never run another child against a potentially dirty fixture.  The
        // operator must reset/verify the disposable environment explicitly.
        for (const remaining of tests.slice(index + 1)) {
          results.push(blockedResult(
            remaining,
            `previous test did not complete safely; run security:synthetic:reset before continuing`,
            { fixtureRecoveryRequired: true },
          ));
        }
        break;
      }
    }
    // A signal can arrive after the last child closes but before the aggregate
    // object is assembled. Preserve fail-closed recovery semantics in that
    // narrow window as well.
    if (activeParentSignal) fixtureRecoveryRequired = true;
    const hasFail = results.some((item) => item.status === "FAIL");
    const hasBlocked = results.some((item) => item.status === "BLOCKED");
    result = {
      // A mutating child that timed out, was interrupted, or emitted incomplete
      // evidence must force the whole run into BLOCKED/recovery state. Returning
      // ordinary FAIL here could invite a caller to continue against a dirty
      // fixture without running the mandated reset.
      status: fixtureRecoveryRequired ? "BLOCKED" : hasFail ? "FAIL" : hasBlocked ? "BLOCKED" : "PASS",
      baseUrl,
      tests: results,
      ...selectionDetails(options),
      ...(fixtureRecoveryRequired ? {
        fixtureRecoveryRequired: true,
        ...(activeParentSignal ? { parentSignal: activeParentSignal } : {}),
        recoveryAction: "Run security:synthetic:reset and security:synthetic:verify before another HTTP run",
      } : {}),
    };
  } finally {
    if (runLock) {
      try {
        releaseRunLock(runLock);
      } catch {
        // A lock that cannot be released must remain visible.  Downgrade a
        // would-be PASS below so the operator inspects the fixture/lock before
        // starting another destructive test.
        lockReleaseFailed = true;
      }
    }
  }
  if (lockReleaseFailed) {
    return {
      ...(result || {}),
      status: "BLOCKED",
      fixtureRecoveryRequired: true,
      recoveryAction: "Synthetic run lock could not be released; inspect the lock and verify/reset the fixture before another run",
    };
  }
  return result;
}

if (isMain()) {
  const handleSignal = (signal) => {
    activeParentSignal = signal;
    // Ask the active child to run its own bounded signal cleanup. The parent
    // waits for the child close event and then emits a BLOCKED/recovery result;
    // it never exits immediately with an unclassified dirty fixture.
    if (activeChildProcess) {
      activeChildProcess.kill("SIGTERM");
      if (!activeParentKillTimer) {
        activeParentKillTimer = setTimeout(() => {
          if (activeChildProcess) activeChildProcess.kill("SIGKILL");
          activeParentKillTimer = null;
        }, CHILD_KILL_GRACE_MS);
        activeParentKillTimer.unref();
      }
    }
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  process.on("SIGHUP", handleSignal);
  try {
    const result = await runHttpHarness();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "PASS" || result.status === "READY" ? 0 : result.status === "BLOCKED" ? 2 : 1;
  } catch (error) {
    const message = redact(error?.message || error);
    console.error(JSON.stringify({ status: "BLOCKED", reason: message, tests: [] }, null, 2));
    process.exitCode = 2;
  } finally {
    if (activeParentKillTimer) {
      clearTimeout(activeParentKillTimer);
      activeParentKillTimer = null;
    }
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    process.removeListener("SIGHUP", handleSignal);
  }
}
