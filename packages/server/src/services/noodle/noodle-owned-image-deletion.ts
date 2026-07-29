import { existsSync, lstatSync, realpathSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { basename, extname, join } from "node:path";
import { eq } from "../../db/file-query.js";
import {
  chatImages,
  characterImages,
  globalImages,
  messages,
  messageSwipes,
  noodleAccounts,
  noodleInteractions,
  noodlePosts,
  personaImages,
} from "../../db/schema/index.js";
import type { DB } from "../../db/connection.js";
import { now } from "../../utils/id-generator.js";
import { assertInsideDir } from "../../utils/security.js";

export const NOODLE_OWNED_IMAGE_DELETION_CAPABILITY = Object.freeze({
  id: "noodle.owned-generated-post-image.delete",
  version: 1,
  route: "/api/noodle/posts/:postId/image",
  keepsPost: true,
  deletesLocalFile: true,
  rejectsExternalMedia: true,
  rejectsGalleryAttachments: true,
  rejectsSharedReferences: true,
});

const IMAGE_METADATA_KEYS = new Set([
  "imageGenerated",
  "imageProvider",
  "imageModel",
  "imageStyleProfileId",
  "characterGalleryImageId",
  "imageGenerationFailed",
  "imageGenerationError",
]);

export type NoodleOwnedImageDeletionCode =
  | "post-not-found"
  | "already-removed"
  | "ownership-unproven"
  | "shared-reference"
  | "source-file-missing"
  | "concurrent-change";

export class NoodleOwnedImageDeletionError extends Error {
  readonly code: Exclude<NoodleOwnedImageDeletionCode, "already-removed">;
  readonly statusCode: number;

  constructor(
    code: Exclude<NoodleOwnedImageDeletionCode, "already-removed">,
    message: string,
    statusCode = code === "post-not-found" ? 404 : 409,
  ) {
    super(message);
    this.name = "NoodleOwnedImageDeletionError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

type FileOperations = {
  exists(path: string): boolean;
  lstat(path: string): Stats;
  realpath(path: string): string;
  rename(from: string, to: string): void;
  unlink(path: string): void;
};

const DEFAULT_FILE_OPERATIONS: FileOperations = {
  exists: existsSync,
  lstat: lstatSync,
  realpath: realpathSync,
  rename: renameSync,
  unlink: unlinkSync,
};

type RawPost = {
  id: string;
  authorAccountId: string;
  imageUrl: string | null;
  imagePrompt: string | null;
  source: string;
  metadata: string;
  authorSnapshot: string;
  updatedAt: string;
};

type RawInteraction = {
  id: string;
  imageUrl: string | null;
  actorSnapshot: string;
};

type RawAccount = {
  id: string;
  avatarUrl: string | null;
  settings: string;
};

type RawCharacterImage = {
  id: string;
  characterId: string;
  filePath: string;
  customKind: string | null;
  customName: string | null;
};

type RawGalleryFile = {
  id: string;
  filePath: string;
};

type RawMessageMedia = {
  extra: string;
};

type OwnedImage = {
  filePath: string;
  metadata: Record<string, unknown>;
  characterImage: RawCharacterImage | null;
};

export type NoodleOwnedImageDeletionResult = {
  status: "deleted" | "already-removed";
  postId: string;
  deletedFile: boolean;
  deletedCharacterGalleryImageId: string | null;
};

type LocalImageReferenceFamily = "gallery" | "character";

type LocalImageReference =
  | {
      kind: "resolved";
      family: LocalImageReferenceFamily;
      key: string;
      realPath: string | null;
    }
  | {
      kind: "ambiguous-local";
      family: LocalImageReferenceFamily;
    }
  | {
      kind: "not-local";
    };

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseMetadata(raw: string): Record<string, unknown> | null {
  return parseJsonRecord(raw);
}

function cleanImageMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !IMAGE_METADATA_KEYS.has(key)));
}

function encodedCharacterImageUrl(characterId: string, filename: string): string {
  return `/api/characters/${encodeURIComponent(characterId)}/gallery/file/${encodeURIComponent(filename)}`;
}

function encodedNoodleImageUrl(filename: string): string {
  return `/api/gallery/file/noodle/${encodeURIComponent(filename)}`;
}

function assertDeletableGeneratedFilename(filename: string): void {
  if (extname(filename).toLowerCase() === ".gif") {
    throw new NoodleOwnedImageDeletionError(
      "ownership-unproven",
      "GIF media is not eligible for Noodle generated-image deletion.",
    );
  }
}

function decodeNoodleFilename(imageUrl: string): string | null {
  const prefix = "/api/gallery/file/noodle/";
  if (!imageUrl.startsWith(prefix)) return null;
  const encoded = imageUrl.slice(prefix.length);
  if (!encoded || encoded.includes("/") || encoded.includes("?") || encoded.includes("#")) return null;
  try {
    const filename = decodeURIComponent(encoded);
    if (!filename || filename === "." || filename === ".." || basename(filename) !== filename) return null;
    if (filename.includes("/") || filename.includes("\\")) return null;
    assertDeletableGeneratedFilename(filename);
    return encodedNoodleImageUrl(filename) === imageUrl ? filename : null;
  } catch {
    return null;
  }
}

function decodedSafePathSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(decoded)
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function normalizedFileIdentity(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizedReferenceKey(parts: string[]): string {
  const normalizedParts = process.platform === "win32" ? parts.map((part) => part.toLowerCase()) : parts;
  return JSON.stringify(normalizedParts);
}

function localGalleryFamilyFromRaw(value: string): LocalImageReferenceFamily | null {
  if (value.includes("/api/gallery/file/")) return "gallery";
  if (value.includes("/api/characters/") && value.includes("/gallery/file")) {
    return "character";
  }
  return null;
}

function classifyLocalImageReference(
  raw: unknown,
  galleryRoot: string,
  realGalleryRoot: string,
  fileOps: FileOperations,
): LocalImageReference {
  if (typeof raw !== "string" || !raw.trim()) return { kind: "not-local" };

  let parsed: URL;
  try {
    parsed = new URL(raw, "http://marinara.invalid/");
  } catch {
    const family = localGalleryFamilyFromRaw(raw);
    return family ? { kind: "ambiguous-local", family } : { kind: "not-local" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "not-local" };
  }

  const decodedSegments = parsed.pathname
    .split("/")
    .slice(1)
    .map((segment) => decodedSafePathSegment(segment));
  if (decodedSegments.some((segment) => segment === null)) {
    const family =
      decodedSegments[0] === "api" && decodedSegments[1] === "gallery" && decodedSegments[2] === "file"
        ? "gallery"
        : decodedSegments[0] === "api" &&
            decodedSegments[1] === "characters" &&
            decodedSegments[3] === "gallery" &&
            decodedSegments[4] === "file"
          ? "character"
          : localGalleryFamilyFromRaw(parsed.pathname);
    return family ? { kind: "ambiguous-local", family } : { kind: "not-local" };
  }
  const segments = decodedSegments as string[];
  let family: LocalImageReferenceFamily;
  let keyParts: string[];
  let relativeParts: string[];
  if (segments[0] === "api" && segments[1] === "gallery" && segments[2] === "file") {
    family = "gallery";
    if (segments.length !== 5) return { kind: "ambiguous-local", family };
    const galleryId = segments[3]!;
    const filename = segments[4]!;
    keyParts = ["gallery", galleryId, filename];
    relativeParts = [galleryId, filename];
  } else if (
    segments[0] === "api" &&
    segments[1] === "characters" &&
    segments[3] === "gallery" &&
    segments[4] === "file"
  ) {
    family = "character";
    if (segments.length !== 6) return { kind: "ambiguous-local", family };
    const characterId = segments[2]!;
    const filename = segments[5]!;
    keyParts = ["character", characterId, filename];
    relativeParts = ["characters", characterId, filename];
  } else {
    return { kind: "not-local" };
  }

  let candidatePath: string;
  try {
    candidatePath = assertInsideDir(galleryRoot, join(galleryRoot, ...relativeParts));
  } catch {
    return { kind: "ambiguous-local", family };
  }

  let realPath: string | null = null;
  if (fileOps.exists(candidatePath)) {
    try {
      const candidateRealPath = fileOps.realpath(candidatePath);
      assertInsideDir(realGalleryRoot, candidateRealPath);
      realPath = normalizedFileIdentity(candidateRealPath);
    } catch {
      return { kind: "ambiguous-local", family };
    }
  }

  return {
    kind: "resolved",
    family,
    key: normalizedReferenceKey(keyParts),
    realPath,
  };
}

function assertRegularOwnedFile(galleryRoot: string, filePath: string, fileOps: FileOperations): string {
  const candidate = assertInsideDir(galleryRoot, filePath);
  if (!fileOps.exists(candidate)) {
    throw new NoodleOwnedImageDeletionError(
      "source-file-missing",
      "The Noodle image record exists, but its local source file is missing.",
    );
  }
  const stats = fileOps.lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new NoodleOwnedImageDeletionError("ownership-unproven", "The Noodle image is not a regular owned file.");
  }
  const realRoot = fileOps.realpath(galleryRoot);
  const realFile = fileOps.realpath(candidate);
  try {
    assertInsideDir(realRoot, realFile);
  } catch {
    throw new NoodleOwnedImageDeletionError(
      "ownership-unproven",
      "The Noodle image resolves outside the owned gallery directory.",
    );
  }
  return candidate;
}

async function readPost(db: DB, postId: string): Promise<RawPost | null> {
  const rows = await db.select().from(noodlePosts).where(eq(noodlePosts.id, postId));
  return (rows[0] as RawPost | undefined) ?? null;
}

async function readCharacterImage(db: DB, imageId: string): Promise<RawCharacterImage | null> {
  const rows = await db.select().from(characterImages).where(eq(characterImages.id, imageId));
  return (rows[0] as RawCharacterImage | undefined) ?? null;
}

function samePostSnapshot(left: RawPost, right: RawPost): boolean {
  return (
    left.id === right.id &&
    left.authorAccountId === right.authorAccountId &&
    left.imageUrl === right.imageUrl &&
    left.imagePrompt === right.imagePrompt &&
    left.source === right.source &&
    left.metadata === right.metadata &&
    left.updatedAt === right.updatedAt
  );
}

async function assertNoSharedReferences(
  db: DB,
  post: RawPost,
  characterImageId: string | null,
  galleryRoot: string,
  targetFilePath: string,
  fileOps: FileOperations,
): Promise<void> {
  const realGalleryRoot = fileOps.realpath(galleryRoot);
  const targetReference = classifyLocalImageReference(post.imageUrl, galleryRoot, realGalleryRoot, fileOps);
  if (targetReference.kind !== "resolved") {
    throw new NoodleOwnedImageDeletionError(
      "ownership-unproven",
      "The generated image URL cannot be resolved to an owned local file.",
    );
  }
  const targetRealPath = normalizedFileIdentity(fileOps.realpath(targetFilePath));
  const isSharedStoredFile = (value: unknown): boolean => {
    if (typeof value !== "string" || !value.trim()) return false;
    let candidatePath: string;
    try {
      candidatePath = assertInsideDir(galleryRoot, join(galleryRoot, value.replace(/\\/g, "/")));
    } catch {
      return true;
    }
    if (normalizedFileIdentity(candidatePath) === normalizedFileIdentity(targetFilePath)) {
      return true;
    }
    if (!fileOps.exists(candidatePath)) return false;
    try {
      const candidateRealPath = fileOps.realpath(candidatePath);
      assertInsideDir(realGalleryRoot, candidateRealPath);
      return normalizedFileIdentity(candidateRealPath) === targetRealPath;
    } catch {
      return true;
    }
  };
  const isSharedUrl = (value: unknown): boolean => {
    const reference = classifyLocalImageReference(value, galleryRoot, realGalleryRoot, fileOps);
    if (reference.kind === "ambiguous-local") return true;
    if (reference.kind !== "resolved") return false;
    return (
      reference.key === targetReference.key || (reference.realPath !== null && reference.realPath === targetRealPath)
    );
  };
  const jsonUrl = (raw: string, key: string): unknown => parseJsonRecord(raw)?.[key];
  const messageExtraReferencesTarget = (raw: string): boolean => {
    const extra = parseJsonRecord(raw);
    if (!extra) return false;
    const attachments = Array.isArray(extra.attachments) ? extra.attachments : [];
    for (const value of attachments) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const attachment = value as Record<string, unknown>;
      if (
        (characterImageId !== null && attachment.galleryId === characterImageId) ||
        isSharedUrl(attachment.url) ||
        isSharedUrl(attachment.data) ||
        (typeof attachment.filePath === "string" && isSharedStoredFile(attachment.filePath))
      ) {
        return true;
      }
    }
    const reactions = Array.isArray(extra.reactions) ? extra.reactions : [];
    return reactions.some(
      (value) =>
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        isSharedUrl((value as Record<string, unknown>).imageUrl),
    );
  };

  const chatGalleryRows = (await db.select().from(chatImages)) as RawGalleryFile[];
  const personaGalleryRows = (await db.select().from(personaImages)) as RawGalleryFile[];
  const globalGalleryRows = (await db.select().from(globalImages)) as RawGalleryFile[];
  const characterGalleryRows = (await db.select().from(characterImages)) as RawCharacterImage[];
  if (
    chatGalleryRows.some((row) => isSharedStoredFile(row.filePath)) ||
    personaGalleryRows.some((row) => isSharedStoredFile(row.filePath)) ||
    globalGalleryRows.some((row) => isSharedStoredFile(row.filePath)) ||
    characterGalleryRows.some((row) => row.id !== characterImageId && isSharedStoredFile(row.filePath))
  ) {
    throw new NoodleOwnedImageDeletionError(
      "shared-reference",
      "This local image is still referenced by another gallery record.",
    );
  }

  const posts = (await db.select().from(noodlePosts)) as RawPost[];
  for (const row of posts) {
    if (row.id !== post.id) {
      const metadata = parseMetadata(row.metadata);
      const sharesCharacterImageId =
        characterImageId !== null &&
        (metadata?.characterGalleryImageId === characterImageId ||
          (metadata?.galleryAttachmentSource === "character-gallery" &&
            metadata.galleryAttachmentId === characterImageId));
      if (isSharedUrl(row.imageUrl) || sharesCharacterImageId) {
        throw new NoodleOwnedImageDeletionError(
          "shared-reference",
          "This local image is still referenced by another Noodle record.",
        );
      }
    }
    if (isSharedUrl(jsonUrl(row.authorSnapshot, "avatarUrl"))) {
      throw new NoodleOwnedImageDeletionError(
        "shared-reference",
        "This local image is still referenced by another Noodle record.",
      );
    }
  }

  const interactions = (await db.select().from(noodleInteractions)) as RawInteraction[];
  for (const interaction of interactions) {
    if (isSharedUrl(interaction.imageUrl) || isSharedUrl(jsonUrl(interaction.actorSnapshot, "avatarUrl"))) {
      throw new NoodleOwnedImageDeletionError(
        "shared-reference",
        "This local image is still referenced by another Noodle record.",
      );
    }
  }

  const accounts = (await db.select().from(noodleAccounts)) as RawAccount[];
  for (const account of accounts) {
    if (isSharedUrl(account.avatarUrl) || isSharedUrl(jsonUrl(account.settings, "bannerUrl"))) {
      throw new NoodleOwnedImageDeletionError(
        "shared-reference",
        "This local image is still referenced by another Noodle record.",
      );
    }
  }

  const messageRows = (await db.select().from(messages)) as RawMessageMedia[];
  const swipeRows = (await db.select().from(messageSwipes)) as RawMessageMedia[];
  if (
    messageRows.some((row) => messageExtraReferencesTarget(row.extra)) ||
    swipeRows.some((row) => messageExtraReferencesTarget(row.extra))
  ) {
    throw new NoodleOwnedImageDeletionError(
      "shared-reference",
      "This local image is still referenced by a chat message.",
    );
  }

  if (targetReference.realPath !== null && targetReference.realPath !== targetRealPath) {
    throw new NoodleOwnedImageDeletionError(
      "ownership-unproven",
      "The generated image URL and owned file resolve to different local files.",
    );
  }
}

async function resolveOwnedImage(
  db: DB,
  post: RawPost,
  galleryRoot: string,
  fileOps: FileOperations,
): Promise<OwnedImage> {
  const metadata = parseMetadata(post.metadata);
  if (
    !post.imageUrl ||
    post.source !== "generated" ||
    !metadata ||
    metadata.imageGenerated !== true ||
    typeof metadata.runId !== "string" ||
    !metadata.runId.trim() ||
    metadata.galleryAttachmentSource !== undefined
  ) {
    throw new NoodleOwnedImageDeletionError(
      "ownership-unproven",
      "Only locally owned images generated by Noodle can be deleted here.",
    );
  }

  const accounts = await db.select().from(noodleAccounts).where(eq(noodleAccounts.id, post.authorAccountId));
  const account = accounts[0];
  if (!account) {
    throw new NoodleOwnedImageDeletionError("ownership-unproven", "The Noodle image author no longer exists.");
  }

  const characterImageId =
    typeof metadata.characterGalleryImageId === "string" && metadata.characterGalleryImageId.trim()
      ? metadata.characterGalleryImageId
      : null;

  if (account.kind === "character") {
    let characterImage: RawCharacterImage | null = null;
    let relativePath: string;
    if (characterImageId) {
      characterImage = await readCharacterImage(db, characterImageId);
      if (
        !characterImage ||
        characterImage.characterId !== account.entityId ||
        characterImage.customKind !== null ||
        characterImage.customName !== null
      ) {
        throw new NoodleOwnedImageDeletionError(
          "ownership-unproven",
          "The generated character image is missing, tagged, or no longer exclusively owned by Noodle.",
        );
      }
      relativePath = characterImage.filePath.replace(/\\/g, "/");
    } else {
      const prefix = `/api/characters/${encodeURIComponent(account.entityId)}/gallery/file/`;
      if (!post.imageUrl.startsWith(prefix)) {
        throw new NoodleOwnedImageDeletionError(
          "ownership-unproven",
          "The generated character image URL does not match its author.",
        );
      }
      const encoded = post.imageUrl.slice(prefix.length);
      if (!encoded || encoded.includes("/") || encoded.includes("?") || encoded.includes("#")) {
        throw new NoodleOwnedImageDeletionError("ownership-unproven", "The character image URL is not safe.");
      }
      let filename: string;
      try {
        filename = decodeURIComponent(encoded);
      } catch {
        throw new NoodleOwnedImageDeletionError("ownership-unproven", "The character image URL is invalid.");
      }
      if (
        !filename ||
        filename === "." ||
        filename === ".." ||
        basename(filename) !== filename ||
        encodedCharacterImageUrl(account.entityId, filename) !== post.imageUrl
      ) {
        throw new NoodleOwnedImageDeletionError("ownership-unproven", "The character image URL is not safe.");
      }
      relativePath = `characters/${account.entityId}/${filename}`;
    }

    const filename = basename(relativePath);
    assertDeletableGeneratedFilename(filename);
    if (
      relativePath !== `characters/${account.entityId}/${filename}` ||
      encodedCharacterImageUrl(account.entityId, filename) !== post.imageUrl
    ) {
      throw new NoodleOwnedImageDeletionError(
        "ownership-unproven",
        "The generated character image path does not match its Noodle URL.",
      );
    }
    const filePath = assertRegularOwnedFile(galleryRoot, join(galleryRoot, relativePath), fileOps);
    return {
      filePath,
      metadata,
      characterImage,
    };
  }

  if (account.kind !== "random_user" || characterImageId) {
    throw new NoodleOwnedImageDeletionError(
      "ownership-unproven",
      "The generated image ownership does not match a supported Noodle account.",
    );
  }
  const filename = decodeNoodleFilename(post.imageUrl);
  if (!filename) {
    throw new NoodleOwnedImageDeletionError(
      "ownership-unproven",
      "The generated Noodle image URL is not an owned local path.",
    );
  }
  const filePath = assertRegularOwnedFile(galleryRoot, join(galleryRoot, "noodle", filename), fileOps);
  return {
    filePath,
    metadata,
    characterImage: null,
  };
}

export async function deleteOwnedNoodlePostImage(input: {
  db: DB;
  postId: string;
  galleryRoot: string;
  fileOperations?: Partial<FileOperations>;
}): Promise<NoodleOwnedImageDeletionResult> {
  const fileOps: FileOperations = { ...DEFAULT_FILE_OPERATIONS, ...input.fileOperations };
  const post = await readPost(input.db, input.postId);
  if (!post) {
    throw new NoodleOwnedImageDeletionError("post-not-found", "Noodle post not found.");
  }
  if (!post.imageUrl) {
    return {
      status: "already-removed",
      postId: post.id,
      deletedFile: false,
      deletedCharacterGalleryImageId: null,
    };
  }

  const owned = await resolveOwnedImage(input.db, post, input.galleryRoot, fileOps);
  const quarantinePath = assertInsideDir(
    input.galleryRoot,
    `${owned.filePath}.${process.pid}.${Date.now()}.noodle-delete`,
  );
  if (fileOps.exists(quarantinePath)) {
    throw new NoodleOwnedImageDeletionError(
      "concurrent-change",
      "A deletion attempt is already using the temporary image path.",
    );
  }

  try {
    await input.db.transaction(async (tx) => {
      const current = await readPost(tx, post.id);
      if (!current || !samePostSnapshot(post, current)) {
        throw new NoodleOwnedImageDeletionError(
          "concurrent-change",
          "The Noodle post changed while its image was being deleted.",
        );
      }
      const characterImageId = owned.characterImage?.id ?? null;
      await assertNoSharedReferences(tx, current, characterImageId, input.galleryRoot, owned.filePath, fileOps);
      if (owned.characterImage) {
        const currentImage = await readCharacterImage(tx, owned.characterImage.id);
        if (
          !currentImage ||
          currentImage.characterId !== owned.characterImage.characterId ||
          currentImage.filePath !== owned.characterImage.filePath ||
          currentImage.customKind !== null ||
          currentImage.customName !== null
        ) {
          throw new NoodleOwnedImageDeletionError(
            "concurrent-change",
            "The character gallery image changed while it was being deleted.",
          );
        }
        await tx.delete(characterImages).where(eq(characterImages.id, owned.characterImage.id));
      }
      await tx
        .update(noodlePosts)
        .set({
          imageUrl: null,
          imagePrompt: null,
          metadata: JSON.stringify(cleanImageMetadata(owned.metadata)),
          updatedAt: now(),
        })
        .where(eq(noodlePosts.id, post.id));
      await tx._fileStore.flush();

      fileOps.rename(owned.filePath, quarantinePath);
      try {
        fileOps.unlink(quarantinePath);
      } catch (error) {
        try {
          if (fileOps.exists(quarantinePath) && !fileOps.exists(owned.filePath)) {
            fileOps.rename(quarantinePath, owned.filePath);
          }
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Noodle image deletion failed and the file could not be restored before database rollback.",
          );
        }
        throw error;
      }
    });
  } catch (error) {
    try {
      if (fileOps.exists(quarantinePath) && !fileOps.exists(owned.filePath)) {
        fileOps.rename(quarantinePath, owned.filePath);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Noodle image deletion failed and the temporary file could not be restored.",
      );
    }
    throw error;
  }

  return {
    status: "deleted",
    postId: post.id,
    deletedFile: true,
    deletedCharacterGalleryImageId: owned.characterImage?.id ?? null,
  };
}
