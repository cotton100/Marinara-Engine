import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { createNoodleStorage } from "../../packages/server/src/services/storage/noodle.storage.js";

const candidateRoot = process.env.NOODLE_IMAGE_DELETE_E2E_ROOT?.trim();
if (!candidateRoot) throw new Error("NOODLE_IMAGE_DELETE_E2E_ROOT is required.");

const resolvedRoot = resolve(candidateRoot);
const dataDir = resolve(resolvedRoot, "data");
const storageDir = resolve(dataDir, "storage");
const expectedStorageDir = resolve(process.env.FILE_STORAGE_DIR ?? "");
if (expectedStorageDir !== storageDir) {
  throw new Error(`FILE_STORAGE_DIR must be ${storageDir}`);
}

const resultPath = join(resolvedRoot, "seed-result.json");
if (existsSync(resultPath)) throw new Error(`Candidate already seeded: ${resultPath}`);

const noodleImageDir = join(dataDir, "gallery", "noodle");
mkdirSync(noodleImageDir, { recursive: true });
mkdirSync(storageDir, { recursive: true });

const filename = "owned-ui-e2e.png";
const imagePath = join(noodleImageDir, filename);
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
writeFileSync(imagePath, Buffer.from(pngBase64, "base64"));

const fileDb = await createFileNativeDB();
const db = fileDb as unknown as DB;
const noodle = createNoodleStorage(db);
const author = await noodle.upsertAccountFromProfile({
  kind: "random_user",
  entityId: "owned-ui-e2e-author",
  displayName: "Image Delete Fixture",
  bio: "Synthetic account for isolated UI validation.",
  invited: true,
});
const actor = await noodle.upsertAccountFromProfile({
  kind: "random_user",
  entityId: "owned-ui-e2e-actor",
  displayName: "Reaction Fixture",
  invited: true,
});
const post = await noodle.createPost({
  authorAccountId: author.id,
  content: "Synthetic image deletion candidate. The post and this like must remain.",
  imageUrl: `/api/gallery/file/noodle/${filename}`,
  imagePrompt: "A one-pixel synthetic fixture used only for isolated deletion validation.",
  source: "generated",
  metadata: {
    imageGenerated: true,
    imageProvider: "synthetic-fixture",
    imageModel: "none",
    runId: "owned-ui-e2e-run",
  },
});
if (!post) throw new Error("Failed to create the synthetic Noodle post.");
const interaction = await noodle.createInteraction(post.id, {
  actorAccountId: actor.id,
  type: "like",
});
if (!interaction) throw new Error("Failed to create the synthetic retained interaction.");

await fileDb._fileStore.flush();
await fileDb._fileStore.close();

const result = {
  candidateRoot: resolvedRoot,
  dataDir,
  storageDir,
  imagePath,
  imageUrl: post.imageUrl,
  postId: post.id,
  interactionId: interaction.id,
  authorAccountId: author.id,
  actorAccountId: actor.id,
};
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify(result));
