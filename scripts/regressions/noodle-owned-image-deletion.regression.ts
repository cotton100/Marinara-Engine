import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "../../packages/server/src/db/connection.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  chats,
  characters,
  characterImages,
  globalImages,
  messages,
  messageSwipes,
  noodleInteractions,
  noodlePosts,
} from "../../packages/server/src/db/schema/index.js";
import {
  deleteOwnedNoodlePostImage,
  NOODLE_OWNED_IMAGE_DELETION_CAPABILITY,
  NoodleOwnedImageDeletionError,
} from "../../packages/server/src/services/noodle/noodle-owned-image-deletion.js";
import { createCharacterGalleryStorage } from "../../packages/server/src/services/storage/character-gallery.storage.js";
import { createNoodleStorage } from "../../packages/server/src/services/storage/noodle.storage.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "marinara-noodle-owned-image-delete-"));
const storageDir = join(fixtureRoot, "storage");
const galleryRoot = join(fixtureRoot, "gallery");
process.env.FILE_STORAGE_DIR = storageDir;
mkdirSync(galleryRoot, { recursive: true });

const syntheticFlushFailure = new Error("synthetic Noodle transaction flush failure");
let rejectNextNoodlePostWrite = false;
const fileDb = await createFileNativeDB({
  beforeTableWrite(table) {
    if (table !== "noodle_posts" || !rejectNextNoodlePostWrite) return;
    rejectNextNoodlePostWrite = false;
    throw syntheticFlushFailure;
  },
});
const db = fileDb as unknown as DB;
const noodle = createNoodleStorage(db);
const characterGallery = createCharacterGalleryStorage(db);

async function expectCode(
  code: NoodleOwnedImageDeletionError["code"],
  operation: () => Promise<unknown>,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof NoodleOwnedImageDeletionError);
    assert.equal(error.code, code);
    return true;
  });
}

async function createRandomUserPost(input: {
  entityId: string;
  filename: string;
  metadata?: Record<string, unknown>;
  imageUrl?: string;
}) {
  const account = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: input.entityId,
    displayName: input.entityId,
  });
  const imageUrl = input.imageUrl ?? `/api/gallery/file/noodle/${encodeURIComponent(input.filename)}`;
  const post = await noodle.createPost({
    authorAccountId: account.id,
    content: `post:${input.entityId}`,
    imageUrl,
    imagePrompt: `prompt:${input.entityId}`,
    source: "generated",
    metadata: {
      runId: `run:${input.entityId}`,
      activityDigestId: `digest:${input.entityId}`,
      imageGenerated: true,
      imageProvider: "fixture",
      imageModel: "fixture",
      imageStyleProfileId: "fixture",
      ...(input.metadata ?? {}),
    },
  });
  assert.ok(post);
  return post;
}

async function createRandomUserOwnedFixture(entityId: string, filename: string) {
  const post = await createRandomUserPost({ entityId, filename });
  const filePath = join(galleryRoot, "noodle", filename);
  writeFileSync(filePath, `${entityId} fixture`);
  return { post, filePath };
}

async function expectSharedReferenceBlocked(input: { postId: string; filePath: string; database?: DB }) {
  let renameCalls = 0;
  let unlinkCalls = 0;
  await expectCode("shared-reference", () =>
    deleteOwnedNoodlePostImage({
      db: input.database ?? db,
      postId: input.postId,
      galleryRoot,
      fileOperations: {
        rename() {
          renameCalls += 1;
        },
        unlink() {
          unlinkCalls += 1;
        },
      },
    }),
  );
  assert.equal(renameCalls, 0);
  assert.equal(unlinkCalls, 0);
  assert.equal(existsSync(input.filePath), true);
  assert.notEqual((await noodle.getPostById(input.postId))?.imageUrl, null);
}

try {
  assert.deepEqual(NOODLE_OWNED_IMAGE_DELETION_CAPABILITY, {
    id: "noodle.owned-generated-post-image.delete",
    version: 1,
    route: "/api/noodle/posts/:postId/image",
    keepsPost: true,
    deletesLocalFile: true,
    rejectsExternalMedia: true,
    rejectsGalleryAttachments: true,
    rejectsSharedReferences: true,
  });

  const noodleDir = join(galleryRoot, "noodle");
  mkdirSync(noodleDir, { recursive: true });

  const ownedPost = await createRandomUserPost({ entityId: "owned", filename: "owned.png" });
  const ownedPath = join(noodleDir, "owned.png");
  writeFileSync(ownedPath, "owned fixture");

  let durableBeforeFileMutation = false;
  const deleted = await deleteOwnedNoodlePostImage({
    db,
    postId: ownedPost.id,
    galleryRoot,
    fileOperations: {
      rename(from, to) {
        const persistedPosts = JSON.parse(
          readFileSync(join(storageDir, "tables", "noodle_posts.json"), "utf8"),
        ) as Array<{ id: string; imageUrl: string | null }>;
        assert.equal(persistedPosts.find((post) => post.id === ownedPost.id)?.imageUrl, null);
        durableBeforeFileMutation = true;
        renameSync(from, to);
      },
    },
  });
  assert.equal(durableBeforeFileMutation, true);
  assert.deepEqual(deleted, {
    status: "deleted",
    postId: ownedPost.id,
    deletedFile: true,
    deletedCharacterGalleryImageId: null,
  });
  assert.equal(existsSync(ownedPath), false);
  const retainedPost = await noodle.getPostById(ownedPost.id);
  assert.ok(retainedPost);
  assert.equal(retainedPost.content, "post:owned");
  assert.equal(retainedPost.imageUrl, null);
  assert.equal(retainedPost.imagePrompt, null);
  assert.equal(retainedPost.metadata.activityDigestId, "digest:owned");
  assert.equal(retainedPost.metadata.runId, "run:owned");
  assert.equal("imageGenerated" in retainedPost.metadata, false);
  assert.equal("imageProvider" in retainedPost.metadata, false);

  const repeated = await deleteOwnedNoodlePostImage({ db, postId: ownedPost.id, galleryRoot });
  assert.deepEqual(repeated, {
    status: "already-removed",
    postId: ownedPost.id,
    deletedFile: false,
    deletedCharacterGalleryImageId: null,
  });

  const externalPost = await createRandomUserPost({
    entityId: "external",
    filename: "external.png",
    imageUrl: "https://example.invalid/external.png",
  });
  await expectCode("ownership-unproven", () =>
    deleteOwnedNoodlePostImage({ db, postId: externalPost.id, galleryRoot }),
  );

  const nonCanonicalTarget = await createRandomUserPost({
    entityId: "noncanonical-target",
    filename: "noncanonical-target.png",
    imageUrl: "/api/gallery/file/noodle/noncanonical-target.png?v=1",
  });
  const nonCanonicalTargetPath = join(noodleDir, "noncanonical-target.png");
  writeFileSync(nonCanonicalTargetPath, "noncanonical target fixture");
  await expectCode("ownership-unproven", () =>
    deleteOwnedNoodlePostImage({ db, postId: nonCanonicalTarget.id, galleryRoot }),
  );
  assert.equal(existsSync(nonCanonicalTargetPath), true);

  const gifPost = await createRandomUserPost({ entityId: "gif", filename: "generated.gif" });
  const gifPath = join(noodleDir, "generated.gif");
  writeFileSync(gifPath, "gif fixture");
  await expectCode("ownership-unproven", () => deleteOwnedNoodlePostImage({ db, postId: gifPost.id, galleryRoot }));
  assert.equal(existsSync(gifPath), true);

  const attachmentPost = await createRandomUserPost({
    entityId: "attachment",
    filename: "attachment.png",
    metadata: { galleryAttachmentSource: "chat-gallery" },
  });
  const attachmentPath = join(noodleDir, "attachment.png");
  writeFileSync(attachmentPath, "attachment fixture");
  await expectCode("ownership-unproven", () =>
    deleteOwnedNoodlePostImage({ db, postId: attachmentPost.id, galleryRoot }),
  );
  assert.equal(existsSync(attachmentPath), true);

  const sharedPost = await createRandomUserPost({ entityId: "shared-a", filename: "shared.png" });
  const sharedAccount = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "shared-b",
    displayName: "shared-b",
  });
  const sharedSecond = await noodle.createPost({
    authorAccountId: sharedAccount.id,
    content: "post:shared-b",
    imageUrl: sharedPost.imageUrl,
    source: "generated",
    metadata: { runId: "run:shared-b", imageGenerated: true },
  });
  assert.ok(sharedSecond);
  const sharedPath = join(noodleDir, "shared.png");
  writeFileSync(sharedPath, "shared fixture");
  await expectCode("shared-reference", () => deleteOwnedNoodlePostImage({ db, postId: sharedPost.id, galleryRoot }));
  assert.equal(existsSync(sharedPath), true);

  const aliasFixture = await createRandomUserOwnedFixture("shared-alias-target", "alias-shared.png");
  const aliasAccount = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "shared-alias-reference",
    displayName: "shared-alias-reference",
  });
  const aliasPost = await noodle.createPost({
    authorAccountId: aliasAccount.id,
    content: "post:shared-alias-reference",
    imageUrl: "/api/gallery/file/noodle/%61lias-shared.png",
    source: "manual",
  });
  assert.ok(aliasPost);
  const blockedReferenceForms = [
    "/api/gallery/file/noodle/%61lias-shared.png",
    "/api/gallery/file/%6Eoodle/alias-shared.png",
    "/%61pi/%67allery/%66ile/noodle/alias-shared.png",
    "/api/gallery/file/noodle/alias-shared.png?v=1",
    "/api/gallery/file/noodle/alias-shared.png#preview",
    "https://example.invalid/api/gallery/file/noodle/alias-shared.png",
    "/api/gallery/file/noodle/./alias-shared.png",
    "/api/gallery/file/noodle/%5Calias-shared.png",
  ];
  for (const imageUrl of blockedReferenceForms) {
    assert.ok(await noodle.updatePost(aliasPost.id, { imageUrl }));
    await expectSharedReferenceBlocked({
      postId: aliasFixture.post.id,
      filePath: aliasFixture.filePath,
    });
  }
  assert.ok(await noodle.updatePost(aliasPost.id, { imageUrl: null }));

  const storedGalleryFixture = await createRandomUserOwnedFixture(
    "shared-gallery-row-target",
    "gallery-row-shared.png",
  );
  const storedGalleryRowId = "global-gallery-shared-reference";
  await db.insert(globalImages).values({
    id: storedGalleryRowId,
    folderId: null,
    filePath: "noodle/gallery-row-shared.png",
    prompt: "",
    provider: "",
    model: "",
    width: null,
    height: null,
    customKind: null,
    customName: null,
    createdAt: new Date().toISOString(),
  });
  await expectSharedReferenceBlocked({
    postId: storedGalleryFixture.post.id,
    filePath: storedGalleryFixture.filePath,
  });
  await db.delete(globalImages).where(eq(globalImages.id, storedGalleryRowId));

  const interactionFixture = await createRandomUserOwnedFixture("shared-interaction-target", "interaction-shared.png");
  const interactionActor = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "shared-interaction-actor",
    displayName: "shared-interaction-actor",
  });
  assert.ok(
    await noodle.createInteraction(interactionFixture.post.id, {
      actorAccountId: interactionActor.id,
      type: "reply",
      content: "shared interaction fixture",
      imageUrl: `${interactionFixture.post.imageUrl}?reply=1`,
    }),
  );
  await expectSharedReferenceBlocked({
    postId: interactionFixture.post.id,
    filePath: interactionFixture.filePath,
  });

  const avatarFixture = await createRandomUserOwnedFixture("shared-avatar-target", "avatar-shared.png");
  const avatarAccount = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "shared-avatar-account",
    displayName: "shared-avatar-account",
  });
  assert.ok(
    await noodle.updateAccount(avatarAccount.id, {
      avatarUrl: `https://example.invalid${avatarFixture.post.imageUrl}`,
    }),
  );
  await expectSharedReferenceBlocked({
    postId: avatarFixture.post.id,
    filePath: avatarFixture.filePath,
  });

  const bannerFixture = await createRandomUserOwnedFixture("shared-banner-target", "banner-shared.png");
  const bannerAccount = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "shared-banner-account",
    displayName: "shared-banner-account",
  });
  assert.ok(
    await noodle.updateAccount(bannerAccount.id, {
      settings: {
        ...bannerAccount.settings,
        bannerUrl: `${bannerFixture.post.imageUrl}#profile`,
      },
    }),
  );
  await expectSharedReferenceBlocked({
    postId: bannerFixture.post.id,
    filePath: bannerFixture.filePath,
  });

  const postSnapshotFixture = await createRandomUserOwnedFixture(
    "shared-post-snapshot-target",
    "post-snapshot-shared.png",
  );
  const postSnapshotAccount = await noodle.getAccountById(postSnapshotFixture.post.authorAccountId);
  assert.ok(postSnapshotAccount);
  await db
    .update(noodlePosts)
    .set({
      authorSnapshot: JSON.stringify({
        id: postSnapshotAccount.id,
        kind: postSnapshotAccount.kind,
        entityId: postSnapshotAccount.entityId,
        handle: postSnapshotAccount.handle,
        displayName: postSnapshotAccount.displayName,
        avatarUrl: postSnapshotFixture.post.imageUrl,
        avatarCrop: postSnapshotAccount.avatarCrop,
      }),
    })
    .where(eq(noodlePosts.id, postSnapshotFixture.post.id));
  await expectSharedReferenceBlocked({
    postId: postSnapshotFixture.post.id,
    filePath: postSnapshotFixture.filePath,
  });

  const interactionSnapshotFixture = await createRandomUserOwnedFixture(
    "shared-interaction-snapshot-target",
    "interaction-snapshot-shared.png",
  );
  const snapshotActor = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "shared-interaction-snapshot-actor",
    displayName: "shared-interaction-snapshot-actor",
  });
  const snapshotInteraction = await noodle.createInteraction(interactionSnapshotFixture.post.id, {
    actorAccountId: snapshotActor.id,
    type: "reply",
    content: "snapshot fixture",
  });
  assert.ok(snapshotInteraction);
  await db
    .update(noodleInteractions)
    .set({
      actorSnapshot: JSON.stringify({
        id: snapshotActor.id,
        kind: snapshotActor.kind,
        entityId: snapshotActor.entityId,
        handle: snapshotActor.handle,
        displayName: snapshotActor.displayName,
        avatarUrl: interactionSnapshotFixture.post.imageUrl,
        avatarCrop: snapshotActor.avatarCrop,
      }),
    })
    .where(eq(noodleInteractions.id, snapshotInteraction.id));
  await expectSharedReferenceBlocked({
    postId: interactionSnapshotFixture.post.id,
    filePath: interactionSnapshotFixture.filePath,
  });

  const messageReferenceFixture = await createRandomUserOwnedFixture("shared-message-target", "message-shared.png");
  const messageReferenceChatId = "shared-message-reference-chat";
  const messageReferenceId = "shared-message-reference";
  const messageReferenceSwipeId = "shared-message-reference-swipe";
  const messageReferenceTimestamp = new Date().toISOString();
  await db.insert(chats).values({
    id: messageReferenceChatId,
    name: "Shared message reference",
    mode: "conversation",
    characterIds: "[]",
    metadata: "{}",
    createdAt: messageReferenceTimestamp,
    updatedAt: messageReferenceTimestamp,
  });
  await db.insert(messages).values({
    id: messageReferenceId,
    chatId: messageReferenceChatId,
    role: "user",
    characterId: null,
    content: "message reference fixture",
    activeSwipeIndex: 0,
    extra: JSON.stringify({
      attachments: [{ type: "image", url: `${messageReferenceFixture.post.imageUrl}?message=1` }],
    }),
    createdAt: messageReferenceTimestamp,
  });
  await db.insert(messageSwipes).values({
    id: messageReferenceSwipeId,
    messageId: messageReferenceId,
    index: 1,
    content: "inactive swipe reference fixture",
    extra: "{}",
    createdAt: messageReferenceTimestamp,
  });
  await expectSharedReferenceBlocked({
    postId: messageReferenceFixture.post.id,
    filePath: messageReferenceFixture.filePath,
  });
  await db.update(messages).set({ extra: "{}" }).where(eq(messages.id, messageReferenceId));
  await db
    .update(messageSwipes)
    .set({
      extra: JSON.stringify({
        attachments: [{ type: "image", data: `${messageReferenceFixture.post.imageUrl}#inactive-swipe` }],
      }),
    })
    .where(eq(messageSwipes.id, messageReferenceSwipeId));
  await expectSharedReferenceBlocked({
    postId: messageReferenceFixture.post.id,
    filePath: messageReferenceFixture.filePath,
  });
  await db.update(messageSwipes).set({ extra: "{}" }).where(eq(messageSwipes.id, messageReferenceSwipeId));

  const concurrentReferenceFixture = await createRandomUserOwnedFixture(
    "shared-concurrent-target",
    "concurrent-shared.png",
  );
  const concurrentActor = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "shared-concurrent-actor",
    displayName: "shared-concurrent-actor",
  });
  let injectedConcurrentReference = false;
  const racingDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async function racingTransaction<T>(callback: (transactionDb: DB) => Promise<T> | T): Promise<T> {
          if (!injectedConcurrentReference) {
            injectedConcurrentReference = true;
            assert.ok(
              await noodle.createInteraction(concurrentReferenceFixture.post.id, {
                actorAccountId: concurrentActor.id,
                type: "reply",
                content: "injected before transaction",
                imageUrl: concurrentReferenceFixture.post.imageUrl,
              }),
            );
          }
          return target.transaction(callback);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DB;
  await expectSharedReferenceBlocked({
    postId: concurrentReferenceFixture.post.id,
    filePath: concurrentReferenceFixture.filePath,
    database: racingDb,
  });
  assert.equal(injectedConcurrentReference, true);

  const rollbackPost = await createRandomUserPost({ entityId: "rollback", filename: "rollback.png" });
  const rollbackPath = join(noodleDir, "rollback.png");
  writeFileSync(rollbackPath, "rollback fixture");
  await assert.rejects(() =>
    deleteOwnedNoodlePostImage({
      db,
      postId: rollbackPost.id,
      galleryRoot,
      fileOperations: {
        unlink() {
          throw new Error("synthetic unlink failure");
        },
      },
    }),
  );
  assert.equal(existsSync(rollbackPath), true);
  const restoredPost = await noodle.getPostById(rollbackPost.id);
  assert.equal(restoredPost?.imageUrl, rollbackPost.imageUrl);
  assert.equal(restoredPost?.imagePrompt, rollbackPost.imagePrompt);
  assert.equal(restoredPost?.metadata.imageGenerated, true);
  const durableRollbackPosts = JSON.parse(
    readFileSync(join(storageDir, "tables", "noodle_posts.json"), "utf8"),
  ) as Array<{ id: string; imageUrl: string | null; imagePrompt: string | null }>;
  const durableRollbackPost = durableRollbackPosts.find((post) => post.id === rollbackPost.id);
  assert.equal(durableRollbackPost?.imageUrl, rollbackPost.imageUrl);
  assert.equal(durableRollbackPost?.imagePrompt, rollbackPost.imagePrompt);

  const renameFailurePost = await createRandomUserPost({
    entityId: "rename-failure",
    filename: "rename-failure.png",
  });
  const renameFailurePath = join(noodleDir, "rename-failure.png");
  writeFileSync(renameFailurePath, "rename failure fixture");
  await fileDb._fileStore.flush();
  const syntheticRenameFailure = new Error("synthetic rename failure");
  let renameFailureUnlinkCalls = 0;
  await assert.rejects(
    () =>
      deleteOwnedNoodlePostImage({
        db,
        postId: renameFailurePost.id,
        galleryRoot,
        fileOperations: {
          rename() {
            throw syntheticRenameFailure;
          },
          unlink() {
            renameFailureUnlinkCalls += 1;
          },
        },
      }),
    syntheticRenameFailure,
  );
  assert.equal(renameFailureUnlinkCalls, 0);
  assert.equal(existsSync(renameFailurePath), true);
  assert.equal((await noodle.getPostById(renameFailurePost.id))?.imageUrl, renameFailurePost.imageUrl);
  const durableRenameFailurePosts = JSON.parse(
    readFileSync(join(storageDir, "tables", "noodle_posts.json"), "utf8"),
  ) as Array<{ id: string; imageUrl: string | null }>;
  assert.equal(
    durableRenameFailurePosts.find((post) => post.id === renameFailurePost.id)?.imageUrl,
    renameFailurePost.imageUrl,
  );

  const flushFailurePost = await createRandomUserPost({
    entityId: "flush-failure",
    filename: "flush-failure.png",
  });
  const flushFailurePath = join(noodleDir, "flush-failure.png");
  writeFileSync(flushFailurePath, "flush failure fixture");
  await fileDb._fileStore.flush();
  let flushFailureRenameCalls = 0;
  let flushFailureUnlinkCalls = 0;
  rejectNextNoodlePostWrite = true;
  await assert.rejects(
    () =>
      deleteOwnedNoodlePostImage({
        db,
        postId: flushFailurePost.id,
        galleryRoot,
        fileOperations: {
          rename() {
            flushFailureRenameCalls += 1;
          },
          unlink() {
            flushFailureUnlinkCalls += 1;
          },
        },
      }),
    syntheticFlushFailure,
  );
  assert.equal(flushFailureRenameCalls, 0);
  assert.equal(flushFailureUnlinkCalls, 0);
  assert.equal(existsSync(flushFailurePath), true);
  assert.equal((await noodle.getPostById(flushFailurePost.id))?.imageUrl, flushFailurePost.imageUrl);
  const durableFlushFailurePosts = JSON.parse(
    readFileSync(join(storageDir, "tables", "noodle_posts.json"), "utf8"),
  ) as Array<{ id: string; imageUrl: string | null }>;
  assert.equal(
    durableFlushFailurePosts.find((post) => post.id === flushFailurePost.id)?.imageUrl,
    flushFailurePost.imageUrl,
  );

  const characterId = "character-delete-fixture";
  const timestamp = new Date().toISOString();
  await db.insert(characters).values({
    id: characterId,
    data: JSON.stringify({ name: "Deletion Fixture" }),
    comment: "",
    avatarPath: null,
    spriteFolderPath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const characterAccount = await noodle.upsertAccountFromProfile({
    kind: "character",
    entityId: characterId,
    displayName: "Deletion Fixture",
  });
  const characterDir = join(galleryRoot, "characters", characterId);
  mkdirSync(characterDir, { recursive: true });
  const characterPath = join(characterDir, "generated.png");
  writeFileSync(characterPath, "character fixture");
  const characterImage = await characterGallery.create({
    characterId,
    filePath: `characters/${characterId}/generated.png`,
    prompt: "fixture",
    provider: "fixture",
    model: "fixture",
  });
  assert.ok(characterImage);
  const characterPost = await noodle.createPost({
    authorAccountId: characterAccount.id,
    content: "post:character",
    imageUrl: `/api/characters/${encodeURIComponent(characterId)}/gallery/file/generated.png`,
    imagePrompt: "prompt:character",
    source: "generated",
    metadata: {
      runId: "run:character",
      imageGenerated: true,
      characterGalleryImageId: characterImage.id,
    },
  });
  assert.ok(characterPost);
  const characterAttachmentAccount = await noodle.upsertAccountFromProfile({
    kind: "random_user",
    entityId: "character-attachment-reference",
    displayName: "character-attachment-reference",
  });
  const crossFamilyAmbiguousReference = await noodle.createPost({
    authorAccountId: characterAttachmentAccount.id,
    content: "post:cross-family-ambiguous-reference",
    imageUrl: `/api/gallery/file/characters/${encodeURIComponent(characterId)}%5Cgenerated.png`,
    source: "manual",
  });
  assert.ok(crossFamilyAmbiguousReference);
  await expectSharedReferenceBlocked({
    postId: characterPost.id,
    filePath: characterPath,
  });
  assert.ok(await noodle.deletePost(crossFamilyAmbiguousReference.id));

  const duplicateCharacterImage = await characterGallery.create({
    characterId,
    filePath: `characters/${characterId}/generated.png`,
    prompt: "duplicate row fixture",
  });
  assert.ok(duplicateCharacterImage);
  await expectSharedReferenceBlocked({
    postId: characterPost.id,
    filePath: characterPath,
  });
  await db.delete(characterImages).where(eq(characterImages.id, duplicateCharacterImage.id));

  const characterUrlAliasReference = await noodle.createPost({
    authorAccountId: characterAttachmentAccount.id,
    content: "post:character-url-alias-reference",
    imageUrl: `/api/characters/${encodeURIComponent(characterId)}/gallery/file/%67enerated.png?v=1`,
    source: "manual",
  });
  assert.ok(characterUrlAliasReference);
  await expectSharedReferenceBlocked({
    postId: characterPost.id,
    filePath: characterPath,
  });
  assert.ok(await noodle.deletePost(characterUrlAliasReference.id));

  const characterIdReference = await noodle.createPost({
    authorAccountId: characterAttachmentAccount.id,
    content: "post:character-id-reference",
    imageUrl: "https://example.invalid/unrelated-character-reference.png",
    source: "manual",
    metadata: {
      characterGalleryImageId: characterImage.id,
    },
  });
  assert.ok(characterIdReference);
  await expectSharedReferenceBlocked({
    postId: characterPost.id,
    filePath: characterPath,
  });
  assert.ok(await noodle.deletePost(characterIdReference.id));

  const characterAttachmentReference = await noodle.createPost({
    authorAccountId: characterAttachmentAccount.id,
    content: "post:character-attachment-reference",
    imageUrl: "/api/gallery/file/noodle/unrelated-attachment.png",
    source: "manual",
    metadata: {
      galleryAttachmentSource: "character-gallery",
      galleryAttachmentId: characterImage.id,
    },
  });
  assert.ok(characterAttachmentReference);
  await expectSharedReferenceBlocked({
    postId: characterPost.id,
    filePath: characterPath,
  });
  assert.ok(await characterGallery.getById(characterImage.id));
  assert.ok(await noodle.deletePost(characterAttachmentReference.id));
  await db
    .update(messageSwipes)
    .set({
      extra: JSON.stringify({
        attachments: [{ type: "image", galleryId: characterImage.id }],
      }),
    })
    .where(eq(messageSwipes.id, messageReferenceSwipeId));
  await expectSharedReferenceBlocked({
    postId: characterPost.id,
    filePath: characterPath,
  });
  assert.ok(await characterGallery.getById(characterImage.id));
  await db.update(messageSwipes).set({ extra: "{}" }).where(eq(messageSwipes.id, messageReferenceSwipeId));
  await db
    .update(messages)
    .set({
      extra: JSON.stringify({
        reactions: [{ emoji: ":fixture:", imageUrl: `${characterPost.imageUrl}#reaction`, by: ["user"] }],
      }),
    })
    .where(eq(messages.id, messageReferenceId));
  await expectSharedReferenceBlocked({
    postId: characterPost.id,
    filePath: characterPath,
  });
  assert.ok(await characterGallery.getById(characterImage.id));
  await db.update(messages).set({ extra: "{}" }).where(eq(messages.id, messageReferenceId));
  assert.ok(
    await noodle.createPost({
      authorAccountId: characterAttachmentAccount.id,
      content: "post:cross-namespace-same-filename",
      imageUrl: "/api/gallery/file/noodle/generated.png",
      source: "manual",
    }),
  );

  const characterDeleted = await deleteOwnedNoodlePostImage({
    db,
    postId: characterPost.id,
    galleryRoot,
  });
  assert.equal(characterDeleted.deletedCharacterGalleryImageId, characterImage.id);
  assert.equal(existsSync(characterPath), false);
  assert.equal(await characterGallery.getById(characterImage.id), null);
  assert.equal((await noodle.getPostById(characterPost.id))?.imageUrl, null);
  const durableCharacterImages = JSON.parse(
    readFileSync(join(storageDir, "tables", "character_images.json"), "utf8"),
  ) as Array<{ id: string }>;
  assert.equal(
    durableCharacterImages.some((image) => image.id === characterImage.id),
    false,
  );

  const taggedPath = join(characterDir, "tagged.png");
  writeFileSync(taggedPath, "tagged fixture");
  const taggedImage = await characterGallery.create({
    characterId,
    filePath: `characters/${characterId}/tagged.png`,
  });
  assert.ok(taggedImage);
  await characterGallery.setTag(taggedImage.id, {
    customKind: "sticker",
    customName: "tagged-fixture",
  });
  const taggedPost = await noodle.createPost({
    authorAccountId: characterAccount.id,
    content: "post:tagged",
    imageUrl: `/api/characters/${encodeURIComponent(characterId)}/gallery/file/tagged.png`,
    source: "generated",
    metadata: {
      runId: "run:tagged",
      imageGenerated: true,
      characterGalleryImageId: taggedImage.id,
    },
  });
  assert.ok(taggedPost);
  await expectCode("ownership-unproven", () => deleteOwnedNoodlePostImage({ db, postId: taggedPost.id, galleryRoot }));
  assert.equal(existsSync(taggedPath), true);
  assert.ok(await characterGallery.getById(taggedImage.id));

  const fallbackPath = join(characterDir, "fallback.png");
  writeFileSync(fallbackPath, "fallback fixture");
  const fallbackImage = await characterGallery.create({
    characterId,
    filePath: `characters/${characterId}/fallback.png`,
  });
  assert.ok(fallbackImage);
  const fallbackPost = await noodle.createPost({
    authorAccountId: characterAccount.id,
    content: "post:fallback",
    imageUrl: `/api/characters/${encodeURIComponent(characterId)}/gallery/file/fallback.png`,
    source: "generated",
    metadata: {
      runId: "run:fallback",
      imageGenerated: true,
    },
  });
  assert.ok(fallbackPost);
  await expectSharedReferenceBlocked({
    postId: fallbackPost.id,
    filePath: fallbackPath,
  });
  assert.ok(await characterGallery.getById(fallbackImage.id));

  await expectCode("post-not-found", () => deleteOwnedNoodlePostImage({ db, postId: "missing-post", galleryRoot }));
} finally {
  await fileDb._fileStore.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
}

process.stdout.write("Noodle owned-image deletion regression passed.\n");
