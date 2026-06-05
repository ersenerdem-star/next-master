export function sanitizeUserFacingMessage(message: unknown, fallback = "The request could not be completed right now.") {
  const raw = String(message || "").trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();

  if (
    normalized.includes("no authenticated session") ||
    normalized.includes("failed to read current session") ||
    normalized.includes("jwt") ||
    normalized.includes("token") ||
    normalized.includes("session expired")
  ) {
    return "Your session has expired. Sign in again.";
  }

  if (normalized.includes("permission denied")) {
    return "You do not have permission for this action.";
  }

  if (normalized.includes("superadmin access required")) {
    return "This system area is enabled only for superadmin. Ask superadmin to open this permission if needed.";
  }

  if (normalized.includes("operations access required")) {
    return "This operation area is not enabled for your user. Ask superadmin to open purchase or warehouse permissions if needed.";
  }

  if (normalized.includes("staff access required")) {
    return "This area is not enabled for your user. Ask superadmin to open the required permission.";
  }

  if (
    normalized.includes("timed out") ||
    normalized.includes("statement timeout") ||
    normalized.includes("canceling statement due to statement timeout")
  ) {
    return "The request took too long. Please try again.";
  }

  if (
    normalized.includes("supabase") ||
    normalized.includes("postgrest") ||
    normalized.includes("postgres") ||
    normalized.includes("graphql") ||
    normalized.includes("data api") ||
    normalized.includes("service role") ||
    normalized.includes("service_role") ||
    normalized.includes("sql editor") ||
    normalized.includes("app rpc") ||
    normalized.includes("app session") ||
    normalized.includes("schema cache") ||
    normalized.includes("column") && normalized.includes("does not exist") ||
    normalized.includes("relation") && normalized.includes("does not exist") ||
    normalized.includes("request failed:")
  ) {
    return fallback;
  }

  return raw;
}

export function sanitizeUserFacingError(error: unknown, fallback = "The request could not be completed right now.") {
  if (error instanceof Error) return sanitizeUserFacingMessage(error.message, fallback);
  return sanitizeUserFacingMessage(error, fallback);
}
