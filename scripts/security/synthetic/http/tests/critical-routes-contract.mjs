/**
 * Unauthenticated contract for the routes listed in critical-routes.mjs.
 *
 * This is a read-only smoke contract.  The parent HTTP harness has already
 * verified the disposable Netlify identity and loopback URL; this child keeps
 * its own runtime and URL checks so direct execution remains fail-closed.
 */

import { TESTS } from "./critical-routes.mjs";
import { isLoopbackFetchUrl } from "../../adapter/fetch-trace.mjs";
import { requireSyntheticRuntime } from "../../require-runtime.mjs";
import { redactError } from "../../safety.mjs";
import { normalizeLoopbackBase, readBoundedBody } from "../request.mjs";

requireSyntheticRuntime();

const env = process.env;
const base = normalizeLoopbackBase(env.NETLIFY_LOCAL_URL || "");
if (!base || !isLoopbackFetchUrl(base)) {
  throw new Error("Refused: NETLIFY_LOCAL_URL must be an http://localhost:<port> or http://127.0.0.1:<port> URL");
}

const ACCEPTED_DENY_STATUS = new Set([400, 401, 403]);
const MAX_BODY_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function parseDenialBody(text, truncated) {
  if (truncated) return { valid: false, reason: "response body exceeded bounded test limit" };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { valid: false, reason: "response body is not JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "response JSON is not an object" };
  }
  const error = typeof value.error === "string" ? value.error.trim() : "";
  if (!error) return { valid: false, reason: "denial response does not contain a non-empty error" };
  return { valid: true };
}

async function runCase(testCase) {
  const route = String(testCase.route || "").replace(/^\/+/, "");
  const target = `${base}/api/${route}`;
  if (!isLoopbackFetchUrl(target)) throw new Error("Refused: resolved critical route is not loopback");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBoundedBody(response, MAX_BODY_BYTES);
    const parsed = parseDenialBody(body.text, body.truncated);
    const denied = ACCEPTED_DENY_STATUS.has(response.status);
    return {
      id: testCase.id,
      route: `/${route}`,
      status: response.status,
      denied,
      bodyValid: parsed.valid,
      passed: denied && parsed.valid,
      ...(denied && parsed.valid ? {} : { failure: parsed.valid ? `unexpected HTTP status ${response.status}` : parsed.reason }),
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const testCase of TESTS) {
  try {
    results.push(await runCase(testCase));
  } catch (error) {
    results.push({
      id: testCase.id,
      route: testCase.route,
      status: 0,
      denied: false,
      bodyValid: false,
      passed: false,
      failure: redactError(error, Object.values(env)),
    });
  }
}

const failed = results.filter((result) => !result.passed);
console.log(JSON.stringify({
  testId: "SYN-CRITICAL-ROUTES-UNAUTH-001",
  status: failed.length ? "FAIL" : "PASS",
  cleanup: "PASS",
  requestMade: true,
  routeCount: results.length,
  passedCount: results.filter((result) => result.passed).length,
  results,
}));
if (failed.length) process.exitCode = 1;
