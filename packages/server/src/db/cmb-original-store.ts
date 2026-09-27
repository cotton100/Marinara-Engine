import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Private on-disk codec, never accepted by the public row write API. */
export type CmbOriginalReference = Readonly<{
  cmbOriginal: 1;
  sha256: string;
  characters: number;
  bytes: number;
}>;

export type CmbOriginalState = {
  state: "inline" | "archived";
  characters: number;
  sha256: string | null;
};

export class CmbOriginalStorageError extends Error {
  readonly code = "CMB_ORIGINAL_UNAVAILABLE";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CmbOriginalStorageError";
  }
}

export function parseCmbOriginalReference(value: unknown): CmbOriginalReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CmbOriginalStorageError("Invalid CMB original reference");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 4 ||
    row.cmbOriginal !== 1 ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256) ||
    !Number.isSafeInteger(row.characters) ||
    (row.characters as number) < 0 ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 2 ||
    (row.bytes as number) > (row.characters as number) * 6 + 2
  ) {
    throw new CmbOriginalStorageError("Invalid CMB original reference");
  }
  return Object.freeze({
    cmbOriginal: 1,
    sha256: row.sha256,
    characters: row.characters as number,
    bytes: row.bytes as number,
  });
}

export function createCmbOriginalPayload(content: string): { reference: CmbOriginalReference; payload: string } {
  // Hash the JSON bytes, not lossy UTF-8 encoding of lone UTF-16 surrogates.
  const payload = JSON.stringify(content);
  return {
    payload,
    reference: Object.freeze({
      cmbOriginal: 1,
      sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
      characters: content.length,
      bytes: Buffer.byteLength(payload, "utf8"),
    }),
  };
}

export function cmbOriginalPath(rootDir: string, reference: CmbOriginalReference): string {
  // The exact reference shape and lower-case digest are also the path boundary.
  const checked = parseCmbOriginalReference(reference);
  return join(rootDir, "cmb-originals", `${checked.sha256}.json`);
}

/** Synchronous like file-native predicates/projection; retains no payload cache. */
export function readCmbOriginal(
  rootDir: string,
  reference: CmbOriginalReference,
  afterRead?: (sha256: string) => void,
): string {
  const checked = parseCmbOriginalReference(reference);
  const path = cmbOriginalPath(rootDir, checked);
  try {
    if (!lstatSync(join(rootDir, "cmb-originals")).isDirectory()) {
      throw new Error("Original directory must be a real directory");
    }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== checked.bytes) throw new Error("Original file size/type mismatch");
    const payload = readFileSync(path);
    afterRead?.(checked.sha256);
    if (payload.byteLength !== checked.bytes || createHash("sha256").update(payload).digest("hex") !== checked.sha256) {
      throw new Error("Original checksum mismatch");
    }
    const content: unknown = JSON.parse(payload.toString("utf8"));
    if (typeof content !== "string" || content.length !== checked.characters) {
      throw new Error("Original content shape mismatch");
    }
    return content;
  } catch (cause) {
    throw new CmbOriginalStorageError("CMB original is missing or damaged", { cause });
  }
}
