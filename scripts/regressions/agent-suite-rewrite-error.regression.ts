// Agent Suite rewrite: a failing model call must reach the client as 502 with the provider's
// sanitised reason, not as a bare 500 "Internal Server Error". Local mock provider only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-suite-rewrite-error-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { agentsRoutes } = await import("../../packages/server/src/routes/agents.routes.js");
const { errorHandler } = await import("../../packages/server/src/middleware/error-handler.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { MAX_RATE_LIMIT_RETRIES } = await import("../../packages/server/src/services/llm/rate-limit-aware-provider.js");

type Behaviour =
  | { status: number; body: string }
  | { status: number; echoAuthorization: true }
  | { content: string; requireCompletionTokens?: boolean };
let behaviour: Behaviour = { content: '{"updates":[]}' };
let rateLimitRequests = 0;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
  if (
    "requireCompletionTokens" in behaviour &&
    behaviour.requireCompletionTokens &&
    ("max_tokens" in body || typeof body.max_completion_tokens !== "number" || body.max_completion_tokens <= 0)
  ) {
    response.writeHead(400, { "content-type": "application/json" }).end(
      JSON.stringify({
        error: { message: "Unsupported parameter: max_tokens. Use max_completion_tokens with this model." },
      }),
    );
    return;
  }
  if ("echoAuthorization" in behaviour) {
    // Some gateways quote the credential they rejected.
    response
      .writeHead(behaviour.status, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { message: `Rejected credential: ${request.headers.authorization ?? ""}` } }));
    return;
  }
  if ("status" in behaviour) {
    if (behaviour.status === 429) {
      // Exercise retry exhaustion without waiting through the production backoff schedule.
      rateLimitRequests++;
      response.setHeader("retry-after", "0");
    }
    response.writeHead(behaviour.status, { "content-type": "application/json" }).end(behaviour.body);
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: behaviour.content } }],
    }),
  );
});

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
app.setErrorHandler(errorHandler);
await app.register(agentsRoutes, { prefix: "/api/agents" });
let checks = 0;
try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Mock rewrite provider",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: "fixture-key-never-echoed",
  });
  const rewrite = (connectionId = connection.id) =>
    app.inject({
      method: "POST",
      url: "/api/agents/suite/rewrite",
      payload: {
        connectionId,
        instruction: "Return the JSON unchanged.",
        selectedText: '{"updates":[]}',
        contextSections: [{ label: "Existing", content: "[]" }],
      },
    });

  const ok = await rewrite();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().rewrittenText, '{"updates":[]}');
  checks++;

  // The real Persona Preference Memory extension uses this same one-shot route.
  // A manually entered GPT-6.1 Sol must work before it reaches the built-in catalog.
  const sol = await createConnectionsStorage(db).create({
    name: "Mock GPT-6.1 rewrite provider",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "gpt-6.1-sol",
    apiKey: "fixture-key-never-echoed",
  });
  behaviour = { content: '{"updates":[]}', requireCompletionTokens: true };
  const solResult = await rewrite(sol.id);
  assert.equal(solResult.statusCode, 200, solResult.body);
  assert.equal(solResult.json().rewrittenText, '{"updates":[]}');
  checks++;

  behaviour = { status: 401, body: JSON.stringify({ error: { message: "Incorrect API key provided" } }) };
  const unauthorized = await rewrite();
  assert.equal(unauthorized.statusCode, 502, unauthorized.body);
  assert.match(unauthorized.json().error, /Rewrite model call failed/u);
  assert.match(unauthorized.json().error, /Incorrect API key provided/u, "the provider's reason is surfaced");
  assert.doesNotMatch(unauthorized.body, /fixture-key-never-echoed/u, "the API key never leaves the server");
  checks++;

  // An upstream that echoes the credential back never gets it past the server.
  behaviour = {
    status: 401,
    body: JSON.stringify({
      error: {
        message:
          "Incorrect API key provided: fixture-key-never-echoed (Authorization: Bearer fixture-key-never-echoed)",
      },
    }),
  };
  const echoed = await rewrite();
  assert.equal(echoed.statusCode, 502, echoed.body);
  assert.doesNotMatch(echoed.body, /fixture-key-never-echoed/u, "an echoed API key is redacted");
  assert.match(echoed.json().error, /Incorrect API key provided: \[redacted\]/u);
  const { redactSecrets } = await import("../../packages/server/src/lib/redact-secrets.js");
  assert.equal(
    redactSecrets(
      "Bearer abcdef123456 sk-abcdefgh1234 ?api_key=zzzzzzzz&x=1 AIzaSyA1234567890abcdefghijklmnop ya29.a0AfB_byCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      [],
    ),
    "Bearer [redacted] sk-[redacted] ?api_key=[redacted]&x=1 [redacted] [redacted]",
  );
  assert.equal(
    redactSecrets("Token budget exceeded; Basic authentication required; model hf_internal_testing/tiny", []),
    "Token budget exceeded; Basic authentication required; model hf_internal_testing/tiny",
    "ordinary words are not credentials",
  );
  assert.equal(
    redactSecrets("none of the loaded models match", ["none", "error"]),
    "none of the loaded models match",
    "placeholder keys of local endpoints are left alone",
  );
  assert.equal(redactSecrets("plain reason stays", ["", null, "abc"]), "plain reason stays");
  checks++;

  // A key stored with padding is sent trimmed, and the echo is still recognised. A key cut by the
  // provider's own truncation leaves no usable prefix behind.
  const padded = await createConnectionsStorage(db).create({
    name: "Padded key",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: "  Pad7Key8Val9Secret0Xyz1Abc2Def3  ",
  });
  behaviour = { status: 401, echoAuthorization: true };
  const paddedEcho = await rewrite(padded.id);
  assert.equal(paddedEcho.statusCode, 502, paddedEcho.body);
  assert.doesNotMatch(paddedEcho.body, /Pad7Key8Val9Secret0Xyz1Abc2Def3/u, "a padded stored key is still recognised");
  assert.match(paddedEcho.json().error, /Rejected credential: Bearer \[redacted\]/u);
  const straddleKey = "Zt4Kq8Wm1Ln6Rp3Vx9Yb2Cd7Fh5Jg0Ms8Nw3Qe6Tq";
  const straddle = await createConnectionsStorage(db).create({
    name: "Prefix-less key",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture",
    apiKey: straddleKey,
  });
  behaviour = { status: 401, body: JSON.stringify({ error: { message: `${"x".repeat(270)} ${straddleKey}` } }) };
  const cut = await rewrite(straddle.id);
  assert.equal(cut.statusCode, 502, cut.body);
  assert.doesNotMatch(
    cut.body,
    new RegExp(straddleKey.slice(0, 8), "u"),
    "a key cut by the provider's truncation leaves no prefix",
  );
  assert.match(cut.json().error, /\[redacted\]/u);
  checks++;

  behaviour = { status: 429, body: JSON.stringify({ error: { message: "Rate limit reached" } }) };
  const limited = await rewrite();
  assert.equal(limited.statusCode, 502);
  assert.match(limited.json().error, /Rate limit reached/u);
  assert.equal(rateLimitRequests, MAX_RATE_LIMIT_RETRIES + 1, "the initial request and all retries reached the mock");
  checks++;

  behaviour = { status: 503, body: "<html><title>Upstream unavailable</title></html>" };
  const html = await rewrite();
  assert.equal(html.statusCode, 502);
  assert.match(html.json().error, /Upstream unavailable/u, "HTML error pages are reduced to their title");
  checks++;

  behaviour = { content: "" };
  const empty = await rewrite();
  assert.equal(empty.statusCode, 502);
  assert.match(empty.json().error, /empty response/u);
  checks++;

  const missing = await rewrite("no-such-connection");
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /connection not found/iu);
  checks++;
  console.log(`agent-suite-rewrite-error: ${checks} regression groups passed`);
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDB?.();
  rmSync(fixtureDir, { recursive: true, force: true });
}
