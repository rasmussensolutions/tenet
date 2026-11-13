import { AuthError, type Sql } from "../auth/store";

export interface ReleaseManifest {
  schema: 1;
  version: string;
  buildId: string;
  protocol: 1;
  updaterProtocol: 1;
  channel: "stable";
  expiresAt: number;
  artifacts: Partial<
    Record<"x86_64" | "aarch64", { url: string; sha256: string; size: number }>
  >;
}
export interface SignedRelease {
  manifest: string;
  signature: string;
}
export const HEX_KEY = /^[a-f0-9]{64}$/;
export function versionParts(version: string) {
  if (!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version))
    throw new AuthError("INVALID_RELEASE");
  return version.split(".").map(Number);
}
export function newer(next: string, current: string) {
  const a = versionParts(next),
    b = versionParts(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
function unhex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}
export async function verifyRelease(
  value: unknown,
  publicKey: string | undefined,
): Promise<{ envelope: SignedRelease; release: ReleaseManifest }> {
  if (!publicKey || !HEX_KEY.test(publicKey))
    throw new AuthError("UPDATES_NOT_CONFIGURED", 503);
  const envelope = value as SignedRelease;
  if (
    !envelope ||
    typeof envelope.manifest !== "string" ||
    envelope.manifest.length > 12000 ||
    typeof envelope.signature !== "string" ||
    !/^[a-f0-9]{128}$/.test(envelope.signature)
  )
    throw new AuthError("INVALID_RELEASE");
  const key = await crypto.subtle.importKey(
    "raw",
    unhex(publicKey),
    "Ed25519",
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      unhex(envelope.signature),
      new TextEncoder().encode(envelope.manifest),
    ))
  )
    throw new AuthError("INVALID_RELEASE_SIGNATURE");
  const release = JSON.parse(envelope.manifest) as ReleaseManifest;
  versionParts(release.version);
  if (
    release.schema !== 1 ||
    release.protocol !== 1 ||
    release.updaterProtocol !== 1 ||
    release.channel !== "stable" ||
    !/^[a-f0-9]{40,64}$/.test(release.buildId) ||
    !Number.isSafeInteger(release.expiresAt) ||
    release.expiresAt <= Date.now() ||
    !release.artifacts ||
    !Object.keys(release.artifacts).length
  )
    throw new AuthError("INCOMPATIBLE_OR_EXPIRED_RELEASE");
  for (const [arch, artifact] of Object.entries(release.artifacts)) {
    if (
      !["x86_64", "aarch64"].includes(arch) ||
      !artifact ||
      !HEX_KEY.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      artifact.size > 32 * 1024 * 1024
    )
      throw new AuthError("INVALID_RELEASE");
    const url = new URL(artifact.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new AuthError("INVALID_RELEASE");
  }
  return {
    envelope: { manifest: envelope.manifest, signature: envelope.signature },
    release,
  };
}
export async function boundedJson(response: Response) {
  if (!response.ok || !response.body)
    throw new AuthError("RELEASE_FETCH_FAILED", 502);
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) throw new AuthError("INVALID_RELEASE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export class Releases {
  constructor(
    private sql: Sql,
    private source?: string,
    public publicKey?: string,
  ) {}
  async check(force = false) {
    if (!this.source || !this.publicKey) return;
    const url = new URL(this.source);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new AuthError("INVALID_RELEASE_SOURCE");
    // Durable throttle across Workers/replicas; a forced check still has a 30-second floor.
    const claimed = await this.sql.query(
      "UPDATE tenet_release SET next_check = $1, checked_at = $3 WHERE id = 1 AND next_check <= $2 AND checked_at <= $4 RETURNING id",
      [
        Date.now() + 900_000,
        force ? Date.now() + 900_000 : Date.now(),
        Date.now(),
        Date.now() - 30_000,
      ],
    );
    if (!claimed.length) return;
    try {
      const response = await fetch(this.source, {
        signal: AbortSignal.timeout(15000),
        redirect: "follow",
        headers: { Accept: "application/json" },
      });
      if (!response.url.startsWith("https:"))
        throw new AuthError("INVALID_RELEASE_SOURCE");
      const { envelope } = await verifyRelease(
        await boundedJson(response),
        this.publicKey,
      );
      await this.sql.query(
        "UPDATE tenet_release SET envelope = $1, checked_at = $2, next_check = $3, error = NULL WHERE id = 1",
        [JSON.stringify(envelope), Date.now(), Date.now() + 900_000],
      );
    } catch {
      await this.sql.query(
        "UPDATE tenet_release SET checked_at = $1, next_check = $2, error = $3 WHERE id = 1",
        [
          Date.now(),
          Date.now() + 900_000,
          "Could not retrieve a valid, compatible signed release.",
        ],
      );
    }
  }
  async read() {
    const [row] = await this.sql.query<{
      envelope: string | null;
      checked_at: number;
      error: string | null;
    }>("SELECT envelope, checked_at, error FROM tenet_release WHERE id = 1");
    let verified: Awaited<ReturnType<typeof verifyRelease>> | null = null;
    if (row?.envelope && this.source && this.publicKey) {
      try {
        verified = await verifyRelease(
          JSON.parse(row.envelope),
          this.publicKey,
        );
      } catch {
        /* Expired/untrusted releases cannot be installed. */
      }
    }
    return {
      configured: Boolean(this.source && this.publicKey),
      checkedAt: Number(row?.checked_at ?? 0),
      error: row?.error ?? null,
      ...verified,
    };
  }
}
