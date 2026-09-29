/**
 * Remove known connection secrets and common credential shapes from text that leaves the server
 * (error details returned to the client, log lines). Providers sanitise and truncate upstream
 * error bodies but do not redact a credential the upstream may echo back.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | null | undefined> = []): string {
  let out = text;
  for (const raw of secrets) {
    // Keys are sent trimmed, so an echo never carries the stored padding.
    const secret = typeof raw === "string" ? raw.trim() : "";
    // Placeholder keys of local endpoints ("none", "ollama") are not credentials; blanking them
    // would only mangle the reason text.
    if (secret.length < 4 || (secret.length < 8 && !/\d/u.test(secret))) continue;
    out = out.split(secret).join("[redacted]");
    // The provider truncates its error text before it reaches us, so a key cut at that boundary
    // survives as a prefix at the very end of the text.
    for (let length = secret.length - 1; length >= 8; length--) {
      if (out.endsWith(secret.slice(0, length))) {
        out = `${out.slice(0, -length)}[redacted]`;
        break;
      }
    }
  }
  // Generic shapes require a digit so that ordinary words ("Token budget", "Basic authentication")
  // keep the reason readable.
  return out
    .replace(/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{6,}/gu, "$1 [redacted]")
    .replace(/\b(sk|rk|pk|xai|gsk|hf|ghp|glpat)[-_](?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{8,}/gu, "$1-[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/gu, "[redacted]")
    .replace(/\bya29\.[A-Za-z0-9_-]{20,}/gu, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu, "[redacted]")
    .replace(/([?&](?:api[_-]?key|apikey|key|token|access_token|auth)=)[^&\s"']+/giu, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|authorization|x-api-key|token)"?\s*[:=]\s*"?)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/giu,
      "$1[redacted]",
    );
}

/**
 * Values of a connection's custom request headers (stored as JSON in `defaultParameters`). They
 * are sent with every request, so an upstream may echo them back like the API key.
 */
export function customHeaderValues(defaultParameters: unknown): string[] {
  try {
    const parsed: unknown = typeof defaultParameters === "string" ? JSON.parse(defaultParameters) : defaultParameters;
    const headers = parsed && typeof parsed === "object" ? (parsed as { customHeaders?: unknown }).customHeaders : null;
    return headers && typeof headers === "object"
      ? Object.values(headers as Record<string, unknown>).filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}
