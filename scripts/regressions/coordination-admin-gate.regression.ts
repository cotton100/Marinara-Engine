import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { basicAuthHook } from "../../packages/server/src/middleware/basic-auth.js";
import { csrfProtectionHook } from "../../packages/server/src/middleware/csrf-protection.js";
import { hostValidationHook } from "../../packages/server/src/middleware/host-validation.js";
import {
  requireCoordinationAdminAccess,
  requirePrivilegedAccess,
} from "../../packages/server/src/middleware/privileged-gate.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exactSecret = "coordination-admin-regression-secret";
const environmentNames = [
  "ADMIN_SECRET",
  "IP_ALLOWLIST",
  "BYPASS_AUTH_TAILSCALE",
  "BYPASS_AUTH_DOCKER",
  "ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK",
] as const;
const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));

for (const name of environmentNames) delete process.env[name];
process.env.IP_ALLOWLIST = "203.0.113.7";
process.env.ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK = "true";

const app = Fastify();
app.addHook("onRequest", hostValidationHook);
app.addHook("onRequest", basicAuthHook);
app.addHook("onRequest", csrfProtectionHook);
app.post("/api/coordination-transition", async (request, reply) => {
  if (!requireCoordinationAdminAccess(request, reply, { trustedNetwork: true })) return;
  return { ok: true };
});

function requestHeaders(secret?: string) {
  return {
    host: "127.0.0.1:7860",
    origin: "http://127.0.0.1:7860",
    "sec-fetch-site": "same-origin",
    ...(secret ? { "x-admin-secret": secret } : {}),
  };
}

try {
  await app.ready();

  const loopbackNoSecret = await app.inject({
    method: "POST",
    url: "/api/coordination-transition",
    headers: requestHeaders(),
    remoteAddress: "127.0.0.1",
  });
  assert.equal(loopbackNoSecret.statusCode, 403);

  // requirePrivilegedAccess alone accepts loopback without ADMIN_SECRET;
  // coordination transitions must still fail closed.
  const directReply = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send() {
      return this;
    },
  };
  const directRequest = {
    headers: { host: "127.0.0.1:7860" },
    ip: "127.0.0.1",
    url: "/api/coordination-transition",
  };
  assert.equal(requirePrivilegedAccess(directRequest as any, directReply as any), true);
  assert.equal(requireCoordinationAdminAccess(directRequest as any, directReply as any), false);
  assert.equal(directReply.statusCode, 403);

  process.env.ADMIN_SECRET = exactSecret;
  for (const [label, remoteAddress, headers] of [
    ["configured missing", "127.0.0.1", requestHeaders()],
    ["configured wrong", "127.0.0.1", requestHeaders("wrong-secret")],
    ["trustedNetwork allowlist", "203.0.113.7", requestHeaders()],
    ["Tailscale bypass", "100.100.100.100", requestHeaders()],
    ["Docker bypass", "172.17.0.2", requestHeaders()],
    ["same-origin", "127.0.0.1", requestHeaders()],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: "/api/coordination-transition",
      headers,
      remoteAddress,
    });
    assert.equal(response.statusCode, 403, `${label} must not bypass exact coordination admin authorization`);
    assert.doesNotMatch(response.body, new RegExp(exactSecret, "u"));
  }

  const exactSecretResponse = await app.inject({
    method: "POST",
    url: "/api/coordination-transition",
    headers: requestHeaders(exactSecret),
    remoteAddress: "127.0.0.1",
  });
  assert.equal(exactSecretResponse.statusCode, 200);
  assert.deepEqual(exactSecretResponse.json(), { ok: true });

  const gateSource = readFileSync(join(repositoryRoot, "packages/server/src/middleware/privileged-gate.ts"), "utf8");
  assert.match(
    gateSource,
    /export function requireCoordinationAdminAccess[\s\S]*requirePrivilegedAccess\(request, reply, options\)[\s\S]*isAdminAuthorized\(request\)/u,
  );
  assert.doesNotMatch(
    gateSource,
    /requireCoordinationAdminAccess[\s\S]*return requirePrivilegedAccess\(/u,
    "coordination access must not be reducible to requirePrivilegedAccess alone",
  );
} finally {
  await app.close();
  for (const name of environmentNames) {
    const previous = previousEnvironment.get(name);
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

console.info("Coordination exact admin gate regression passed.");
