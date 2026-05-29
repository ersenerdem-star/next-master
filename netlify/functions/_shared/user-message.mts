export function sanitizeUserFacingMessage(message: unknown, fallback = "The request could not be completed right now.") {
  const raw = String(message || "").trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();

  if (normalized.includes("permission denied")) {
    return "You do not have permission for this action.";
  }

  if (
    normalized.includes("jwt") ||
    normalized.includes("token") ||
    normalized.includes("session expired") ||
    normalized.includes("no authenticated session")
  ) {
    return "Your session has expired. Sign in again.";
  }

  if (normalized.includes("timed out")) {
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
