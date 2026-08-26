import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "marinara-noodle-companion-snapshot-"));
const dataDir = join(root, "data");
const storageDir = join(root, "storage");
const previousEnvironment = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  ADMIN_SECRET: process.env.ADMIN_SECRET,
  MARINARA_REQUIRE_ADMIN_SECRET_ON_LOOPBACK: process.env.MARINARA_REQUIRE_ADMIN_SECRET_ON_LOOPBACK,
};
const adminSecret = "a".repeat(64);
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = storageDir;
process.env.ADMIN_SECRET = adminSecret;
process.env.MARINARA_REQUIRE_ADMIN_SECRET_ON_LOOPBACK = "false";

const { default: Fastify } = await import("../../../packages/server/node_modules/fastify/fastify.js");
const { createFileNativeDB } = await import("../../../packages/server/src/db/file-backed-store.js");
const { appSettings, noodleAccounts, noodleInteractions, noodlePosts } =
  await import("../../../packages/server/src/db/schema/index.js");
const { capabilityPackagesRoutes } = await import("../../../packages/server/src/routes/capability-packages.routes.js");

const registryPath = join(dataDir, "capability-packages", "installed.json");
const manifest = {
  schemaVersion: 1 as const,
  id: "noodle",
  name: "Noodle",
  version: "1.0.0",
  description: "Regression fixture for the read-only companion snapshot.",
  engine: { min: "2.4.4", maxExclusive: "3.0.0" },
  kind: ["agent" as const],
  entrypoints: { server: "server.mjs" },
  files: [{ path: "server.mjs", sha256: "b".repeat(64), bytes: 1 }],
  permissions: ["routes" as const],
  restartRequired: true,
};

function writeRegistry(status: "active" | "restart-required", readiness: "pending" | "ready") {
  mkdirSync(join(dataDir, "capability-packages"), { recursive: true });
  writeFileSync(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      packages: [
        {
          id: "noodle",
          version: manifest.version,
          manifest,
          installedAt: "2026-08-27T00:00:00.000Z",
          status,
          error: null,
          readiness,
          readinessError: null,
          legacy: false,
        },
      ],
    }),
  );
}

function writeEmptyRegistry() {
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, packages: [] }));
}

const fileDb = await createFileNativeDB();
const app = Fastify({ logger: false });
app.decorate("db", fileDb);

try {
  await dbSeed();
  await fileDb._fileStore.flush();
  await app.register(capabilityPackagesRoutes, { prefix: "/api/capability-packages" });
  await app.ready();

  writeRegistry("active", "ready");
  const unauthorized = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    remoteAddress: "127.0.0.1",
  });
  assert.equal(
    unauthorized.statusCode,
    403,
    "the snapshot requires the exact admin secret even when the request is genuinely loopback",
  );

  const wrongSecret = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    headers: { "x-admin-secret": "c".repeat(64) },
    remoteAddress: "127.0.0.1",
  });
  assert.equal(wrongSecret.statusCode, 403, "a mismatched admin secret must be rejected");

  writeRegistry("active", "pending");
  const pending = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    headers: { "x-admin-secret": adminSecret },
  });
  assert.equal(pending.statusCode, 404, "a Noodle runtime that is not ready must stay unavailable");

  writeRegistry("restart-required", "ready");
  const inactive = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    headers: { "x-admin-secret": adminSecret },
  });
  assert.equal(inactive.statusCode, 404, "a Noodle package that is not active must stay unavailable");

  writeEmptyRegistry();
  const absent = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    headers: { "x-admin-secret": adminSecret },
  });
  assert.equal(absent.statusCode, 404, "an uninstalled Noodle package must stay unavailable");

  writeRegistry("active", "ready");
  const before = await storedRows();
  const beforeDigest = tableDigest(before);
  const response = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    headers: { "x-admin-secret": adminSecret },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");

  const snapshot = response.json();
  assert.deepEqual(Object.keys(snapshot).sort(), ["accounts", "interactions", "posts", "schemaVersion"]);
  assert.equal(snapshot.schemaVersion, 1, "the companion contract is explicitly versioned");
  assert.deepEqual(
    snapshot.accounts.map((account: { id: string }) => account.id),
    ["account-new", "account-old"],
    "only public accounts are returned in descending updatedAt order",
  );
  assert.deepEqual(
    Object.keys(snapshot.accounts[0]).sort(),
    ["displayName", "entityId", "handle", "id", "kind"],
    "accounts expose only the companion identity fields",
  );
  assert.equal(
    snapshot.accounts.find((account: { id: string }) => account.id === "account-old").handle,
    "Needs Normalizing",
    "the read-only path must not reconcile stored public handles",
  );
  assert.equal(snapshot.posts.length, 160, "the companion snapshot matches Noodle's public bootstrap limit");
  assert.equal(snapshot.posts[0].id, "post-161", "posts are newest first");
  assert.equal(snapshot.posts.at(-1).id, "post-002", "only the newest 160 public posts are returned");
  assert.deepEqual(
    Object.keys(snapshot.posts[0]).sort(),
    ["authorAccountId", "authorSnapshot", "content", "createdAt", "id"],
    "posts omit metadata, media, access, and update fields",
  );
  assert.deepEqual(snapshot.posts[0].authorSnapshot, { displayName: "account-new" });
  assert.equal(snapshot.posts[1].authorSnapshot, null, "invalid stored snapshots remain null without leaking raw data");
  assert.deepEqual(
    snapshot.interactions.map((interaction: { id: string }) => interaction.id),
    ["interaction-early", "interaction-late"],
    "replies are oldest first and exclude likes, votes, private actors, and posts outside the bounded feed",
  );
  assert.deepEqual(
    Object.keys(snapshot.interactions[0]).sort(),
    ["actorAccountId", "actorSnapshot", "content", "createdAt", "id", "parentInteractionId", "postId", "type"],
    "interactions expose only the fields consumed by the companion",
  );
  assert.equal(snapshot.interactions[0].actorSnapshot, null);
  assert.deepEqual(snapshot.interactions[1].actorSnapshot, { displayName: "account-new" });

  for (let poll = 1; poll < 100; poll += 1) {
    const repeated = await app.inject({
      method: "GET",
      url: "/api/capability-packages/noodle/snapshot",
      headers: { "x-admin-secret": adminSecret },
    });
    assert.equal(repeated.statusCode, 200, `poll ${poll + 1} failed: ${repeated.body}`);
    assert.deepEqual(repeated.json(), snapshot, `poll ${poll + 1} changed the read-only projection`);
  }

  await fileDb._fileStore.flush();
  const after = await storedRows();
  assert.deepEqual(after, before, "repeated snapshot requests must not change Noodle storage rows");
  assert.equal(tableDigest(after), beforeDigest, "repeated snapshot requests must preserve the Noodle table digest");

  await fileDb
    .insert(noodleInteractions)
    .values(
      Array.from({ length: 4094 }, (_, index) =>
        interactionRow(
          `capacity-reply-${String(index).padStart(4, "0")}`,
          `post-${String((index % 160) + 2).padStart(3, "0")}`,
          index % 2 === 0 ? "account-old" : "account-new",
          new Date(Date.parse("2026-08-27T04:00:00.000Z") + index).toISOString(),
        ),
      ),
    );
  await fileDb._fileStore.flush();
  const atCapacityBefore = await storedRows();
  const atCapacityDigest = tableDigest(atCapacityBefore);
  const atCapacity = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    headers: { "x-admin-secret": adminSecret },
  });
  assert.equal(atCapacity.statusCode, 200, atCapacity.body);
  assert.equal(atCapacity.json().interactions.length, 4096, "the exact reply capacity remains available");
  await fileDb._fileStore.flush();
  const atCapacityAfter = await storedRows();
  assert.deepEqual(atCapacityAfter, atCapacityBefore, "a snapshot at capacity must remain side-effect-free");
  assert.equal(tableDigest(atCapacityAfter), atCapacityDigest, "a snapshot at capacity must preserve storage digests");

  await fileDb
    .insert(noodleInteractions)
    .values(interactionRow("capacity-reply-overflow", "post-161", "account-new", "2026-08-27T05:00:00.000Z"));
  await fileDb._fileStore.flush();
  const overflowBefore = await storedRows();
  const overflowDigest = tableDigest(overflowBefore);
  const overflow = await app.inject({
    method: "GET",
    url: "/api/capability-packages/noodle/snapshot",
    headers: { "x-admin-secret": adminSecret },
  });
  assert.equal(overflow.statusCode, 409, overflow.body);
  assert.deepEqual(overflow.json(), {
    error: "Noodle companion snapshot exceeds the supported reply capacity",
  });
  await fileDb._fileStore.flush();
  const overflowAfter = await storedRows();
  assert.deepEqual(overflowAfter, overflowBefore, "an overflowing snapshot must fail without changing storage rows");
  assert.equal(tableDigest(overflowAfter), overflowDigest, "an overflowing snapshot must preserve storage digests");
} finally {
  await app.close();
  await fileDb._fileStore.close();
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

async function dbSeed() {
  await fileDb.insert(appSettings).values({
    key: "noodle.settings",
    value: JSON.stringify({ refreshesPerDay: 3 }),
    updatedAt: "2026-08-27T00:00:00.000Z",
  });
  await fileDb.insert(noodleAccounts).values([
    accountRow("account-old", "persona-old", "Needs Normalizing", "2026-08-27T00:00:01.000Z"),
    accountRow("account-new", "persona-new", "new-account", "2026-08-27T00:00:03.000Z"),
    accountRow("noodle.settings", "legacy-settings", "legacy-settings", "2026-08-27T00:00:05.000Z"),
    {
      ...accountRow("account-private", "persona-private", "private-account", "2026-08-27T00:00:04.000Z"),
      platform: "noodler",
      visibility: "private",
      noodleAccountId: "account-new",
      publicAccountId: "account-new",
    },
  ]);

  const firstPostAt = Date.parse("2026-08-27T01:00:00.000Z");
  await fileDb.insert(noodlePosts).values([
    ...Array.from({ length: 162 }, (_, index) => ({
      id: `post-${String(index).padStart(3, "0")}`,
      authorAccountId: index % 2 === 0 ? "account-old" : "account-new",
      title: null,
      content: `Public post ${index}`,
      imageUrl: null,
      imagePrompt: null,
      imageClaimToken: null,
      imageClaimLeaseUntil: null,
      parentPostId: null,
      quotePostId: null,
      source: "manual",
      access: "public",
      metadata: "{}",
      authorSnapshot:
        index % 2 === 0
          ? "{}"
          : JSON.stringify({
              id: "account-new",
              kind: "persona",
              entityId: "persona-new",
              handle: "new-account",
              displayName: "account-new",
              avatarUrl: "/private/avatar.png",
              avatarCrop: { x: 1, y: 2, scale: 3 },
            }),
      createdAt: new Date(firstPostAt + index * 1_000).toISOString(),
      updatedAt: new Date(firstPostAt + index * 1_000).toISOString(),
    })),
    {
      id: "post-settings-sentinel",
      authorAccountId: "noodle.settings",
      title: null,
      content: "Legacy settings sentinel content must never enter the companion feed",
      imageUrl: null,
      imagePrompt: null,
      imageClaimToken: null,
      imageClaimLeaseUntil: null,
      parentPostId: null,
      quotePostId: null,
      source: "manual",
      access: "public",
      metadata: "{}",
      authorSnapshot: "{}",
      createdAt: "2026-08-27T02:01:00.000Z",
      updatedAt: "2026-08-27T02:01:00.000Z",
    },
    {
      id: "post-private",
      authorAccountId: "account-private",
      title: null,
      content: "NoodleR content must stay private",
      imageUrl: null,
      imagePrompt: null,
      imageClaimToken: null,
      imageClaimLeaseUntil: null,
      parentPostId: null,
      quotePostId: null,
      source: "manual",
      access: "public",
      metadata: "{}",
      authorSnapshot: "{}",
      createdAt: "2026-08-27T02:00:00.000Z",
      updatedAt: "2026-08-27T02:00:00.000Z",
    },
  ]);

  await fileDb
    .insert(noodleInteractions)
    .values([
      interactionRow("interaction-late", "post-161", "account-new", "2026-08-27T03:00:02.000Z"),
      interactionRow("interaction-early", "post-160", "account-old", "2026-08-27T03:00:01.000Z"),
      interactionRow("interaction-private-actor", "post-161", "account-private", "2026-08-27T03:00:00.000Z"),
      interactionRow("interaction-old-post", "post-000", "account-old", "2026-08-27T03:00:03.000Z"),
      interactionRow("interaction-like", "post-161", "account-new", "2026-08-27T03:00:04.000Z", "like"),
      interactionRow("interaction-vote", "post-161", "account-new", "2026-08-27T03:00:05.000Z", "vote"),
    ]);
}

function accountRow(id: string, entityId: string, handle: string, updatedAt: string) {
  return {
    id,
    kind: "persona",
    entityId,
    handle,
    displayName: id,
    bio: "",
    avatarUrl: null,
    invited: "false",
    settings: "{}",
    platform: "noodle",
    noodleAccountId: null,
    visibility: "public",
    publicAccountId: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt,
  };
}

function interactionRow(
  id: string,
  postId: string,
  actorAccountId: string,
  createdAt: string,
  type: "reply" | "like" | "vote" = "reply",
) {
  return {
    id,
    postId,
    parentInteractionId: null,
    actorAccountId,
    type,
    content: id,
    imageUrl: null,
    actorSnapshot:
      actorAccountId === "account-new"
        ? JSON.stringify({
            id: "account-new",
            kind: "persona",
            entityId: "persona-new",
            handle: "new-account",
            displayName: "account-new",
            avatarUrl: "/private/avatar.png",
            avatarCrop: null,
          })
        : "{}",
    createdAt,
  };
}

async function storedRows() {
  return {
    appSettings: await fileDb.select().from(appSettings),
    accounts: await fileDb.select().from(noodleAccounts),
    posts: await fileDb.select().from(noodlePosts),
    interactions: await fileDb.select().from(noodleInteractions),
  };
}

function tableDigest(rows: Awaited<ReturnType<typeof storedRows>>) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

process.stdout.write("Noodle companion snapshot regression passed.\n");
