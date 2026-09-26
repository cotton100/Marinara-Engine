import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const dataDir = mkdtempSync(join(tmpdir(), "local-capability-archive-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.MARINARA_ENV_FILE = join(dataDir, ".env");
writeFileSync(process.env.MARINARA_ENV_FILE, "");
globalThis.fetch = async () => {
  throw new Error("Network forbidden in offline installer regression");
};
const serverRequire = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const AdmZip = serverRequire("adm-zip");
const { installLocalCapabilityArchive, capabilityPackageManager } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const registry = join(dataDir, "capability-packages", "installed.json");
type Options = {
  id?: string;
  version?: string;
  extra?: boolean;
  badFileHash?: boolean;
  badManifest?: boolean;
  min?: string;
  unsafe?: boolean;
};
function fixture(options: Options = {}) {
  const payload = Buffer.from("export async function activate() { return () => {}; }\n");
  const manifest = {
    schemaVersion: 1,
    id: options.id ?? "offline-test",
    name: "Offline test",
    version: options.version ?? "1.0.0",
    description: "Synthetic offline installation fixture",
    engine: { min: options.min ?? "2.4.6", maxExclusive: "4.0.0" },
    kind: ["conversation-calls"],
    entrypoints: { server: "server.mjs" },
    permissions: ["routes"],
    restartRequired: true,
    files: [{ path: "server.mjs", sha256: options.badFileHash ? "0".repeat(64) : sha(payload), bytes: payload.length }],
  };
  const zip = new AdmZip();
  zip.addFile(
    "manifest.json",
    Buffer.from(JSON.stringify({ ...manifest, ...(options.badManifest ? { name: "Different" } : {}) })),
  );
  zip.addFile("server.mjs", payload);
  if (options.extra) zip.addFile("undeclared.txt", Buffer.from("not declared"));
  if (options.unsafe) {
    zip.addFile("unsafe.txt", Buffer.from("path fixture"));
    zip.getEntry("unsafe.txt").entryName = "../escape.txt";
  }
  const archive: Buffer = zip.toBuffer();
  const entry = {
    manifest,
    artifact: { url: "https://example.com/offline-test.zip", bytes: archive.length, sha256: sha(archive) },
  };
  return { entry, archive, pin: entry.artifact.sha256 };
}
let checks = 0;
async function rejected(f: ReturnType<typeof fixture>, pattern: RegExp, pin = f.pin) {
  const before = existsSync(registry) ? readFileSync(registry, "utf8") : null;
  await assert.rejects(() => installLocalCapabilityArchive(f.entry, f.archive, pin), pattern);
  assert.equal(
    existsSync(registry) ? readFileSync(registry, "utf8") : null,
    before,
    "Failed installs preserve registry",
  );
  checks++;
}
await rejected(fixture(), /approved artifact/, "0".repeat(64));
const corrupted = fixture();
corrupted.archive[corrupted.archive.length - 1]! ^= 1;
await rejected(corrupted, /checksum does not match/);
const wrongSize = fixture();
wrongSize.entry.artifact.bytes++;
await rejected(wrongSize, /size does not match/);
await rejected(fixture({ badFileHash: true }), /file checksum mismatch/);
await rejected(fixture({ badManifest: true }), /manifest does not match/);
await rejected(fixture({ extra: true }), /undeclared or missing/);
await rejected(fixture({ unsafe: true }), /Unsafe|unsafe|traversal|relative/);
await rejected(fixture({ min: "3.0.0" }), /requires Marinara Engine/);
const first = fixture();
const installed = await installLocalCapabilityArchive(first.entry, first.archive, first.pin);
assert.equal(installed.status, "restart-required");
assert.equal(installed.version, "1.0.0");
assert.ok(existsSync(join(dataDir, "capability-packages", "versions", "offline-test", "1.0.0", "server.mjs")));
checks++;
const other = fixture({ id: "other-fixture" });
await installLocalCapabilityArchive(other.entry, other.archive, other.pin);
const upgrade = fixture({ version: "1.0.1-local.1" });
await installLocalCapabilityArchive(upgrade.entry, upgrade.archive, upgrade.pin);
assert.ok(
  existsSync(join(dataDir, "capability-packages", "versions", "offline-test", "1.0.0", "server.mjs")),
  "Old version retained",
);
const records = JSON.parse(readFileSync(registry, "utf8"));
assert.equal(records.packages.length, 2);
assert.equal(records.packages.find((p: { id: string }) => p.id === "other-fixture").version, "1.0.0");
assert.equal(records.packages.find((p: { id: string }) => p.id === "offline-test").previousVersion, "1.0.0");
assert.equal((await capabilityPackageManager.installed()).length, 2);
checks++;
await rejected(first, /downgrade|older/i);
console.log(`local capability archive regression: ${checks} checks passed; fixture=${dataDir}`);
