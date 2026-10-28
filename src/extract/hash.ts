import { createHash } from "node:crypto";
import type { Stats } from "node:fs";

/** Git's blob id for these bytes: what `git hash-object` would print. */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}
export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** The two modes Git records for a regular file. */
export function gitFileMode(stats: Pick<Stats, "mode">): string {
  return (stats.mode & 0o111) === 0 ? "100644" : "100755";
}
