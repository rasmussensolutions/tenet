import { AuthError, hash, randomToken, type Sql } from "../auth/store";
import {
  DETECTED_PROVIDERS,
  type DetectedProvider,
  type Hosting,
} from "./providers";

export const ENROLLMENT_MS = 10 * 60_000;
export const OFFLINE_MS = 60_000;
export const TOKEN = /^[a-f0-9]{64}$/;

export interface Telemetry {
  version: 1;
  hostname: string;
  ipAddresses?: string[];
  hosting?: Hosting | null;
  os: string;
  arch: string;
  agentVersion: string;
  agentBuildId?: string;
  cpuCount: number;
  cpuPercent: number;
  memoryTotal: number;
  memoryUsed: number;
  uptime: number;
  disks: { mount: string; total: number; used: number }[];
}

type MachineRow = Record<string, unknown> & {
  id: string;
  name: string;
  state: "pending" | "active" | "revoked";
  created_at: number | string;
  enrollment_expires: number | string;
  last_seen: number | string | null;
  telemetry: string | null;
  updater_key: string | null;
  updater_seen: number | null;
  provider_override: string | null;
};

function hasControlCharacters(value: string) {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AuthError("INVALID_TELEMETRY");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    hasControlCharacters(value)
  )
    throw new AuthError("INVALID_TELEMETRY");
  return value;
}
function number(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
  integer = true,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new AuthError("INVALID_TELEMETRY");
  return value;
}
function isIP(value: string): boolean {
  if (!value.includes(":"))
    return (
      /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) &&
      value.split(".").every((part) => Number(part) <= 255)
    );
  if (!/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}
function ipAddresses(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((ip) => typeof ip !== "string" || ip.length > 45 || !isIP(ip))
  )
    throw new AuthError("INVALID_TELEMETRY");
  return [...new Set(value as string[])];
}
function hosting(value: unknown): Hosting | null {
  if (value === null) return null;
  const data = record(value);
  if (!DETECTED_PROVIDERS.includes(data.provider as DetectedProvider))
    throw new AuthError("INVALID_TELEMETRY");
  const result: Hosting = { provider: data.provider as DetectedProvider };
  for (const field of ["region", "zone"] as const) {
    if (data[field] === undefined) continue;
    const component = text(data[field], 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(component))
      throw new AuthError("INVALID_TELEMETRY");
    result[field] = component;
  }
  return result;
}
/** Reconstruct the allowed payload; never persist arbitrary agent-supplied JSON. */
export function telemetry(value: unknown): Telemetry {
  const data = record(value);
  if (
    data.version !== 1 ||
    !Array.isArray(data.disks) ||
    data.disks.length > 32
  )
    throw new AuthError("INVALID_TELEMETRY");
  const memoryTotal = number(data.memoryTotal);
  const cpuCount = number(data.cpuCount, 65536);
  if (!memoryTotal || !cpuCount) throw new AuthError("INVALID_TELEMETRY");
  return {
    version: 1,
    hostname: text(data.hostname, 255),
    ...(data.hosting === undefined ? {} : { hosting: hosting(data.hosting) }),
    ...(data.ipAddresses === undefined
      ? {}
      : { ipAddresses: ipAddresses(data.ipAddresses) }),
    os: text(data.os, 255),
    arch: text(data.arch, 32),
    agentVersion: text(data.agentVersion, 64),
    ...(data.agentBuildId === undefined
      ? {}
      : { agentBuildId: text(data.agentBuildId, 64) }),
    cpuCount,
    cpuPercent: number(data.cpuPercent, 100, false),
    memoryTotal,
    memoryUsed: number(data.memoryUsed, memoryTotal),
    uptime: number(data.uptime),
    disks: data.disks.map((entry) => {
      const disk = record(entry);
      const total = number(disk.total);
      if (!total) throw new AuthError("INVALID_TELEMETRY");
      return {
        mount: text(disk.mount, 512),
        total,
        used: number(disk.used, total),
      };
    }),
  };
}

export class MachineStore {
  constructor(private sql: Sql) {}

  async create(name: unknown) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.trim().length > 80 ||
      hasControlCharacters(name)
    )
      throw new AuthError("INVALID_MACHINE_NAME");
    const id = crypto.randomUUID();
    const token = randomToken();
    const expiresAt = Date.now() + ENROLLMENT_MS;
    // Bound ordinary growth, including abandoned enrollments. Concurrent inserts may slightly exceed this soft cap.
    const rows = await this.sql.query(
      `INSERT INTO tenet_machine (id, name, state, enrollment_hash, enrollment_expires, created_at)
       SELECT $1, $2, 'pending', $3, $4, $5 WHERE (SELECT COUNT(*) FROM tenet_machine) < 1000 RETURNING id`,
      [id, name.trim(), await hash(token), expiresAt, Date.now()],
    );
    if (!rows.length) throw new AuthError("MACHINE_LIMIT", 409);
    return { id, token, expiresAt };
  }

  async enroll(token: string, credential: unknown) {
    if (
      !TOKEN.test(token) ||
      typeof credential !== "string" ||
      !TOKEN.test(credential) ||
      credential === token
    )
      throw new AuthError("INVALID_ENROLLMENT", 401);
    const digest = await hash(token);
    const credentialHash = await hash(credential);
    const now = Date.now();
    const rows = await this.sql.query<{ id: string }>(
      `UPDATE tenet_machine SET state = 'active', credential_hash = $1, enrolled_at = $2
       WHERE enrollment_hash = $3 AND enrollment_expires > $2 AND state = 'pending' RETURNING id`,
      [credentialHash, now, digest],
    );
    if (rows[0]) return { id: rows[0].id, first: true };
    // A lost response can be retried only by the same persisted credential, within the original TTL.
    const [existing] = await this.sql.query<{ id: string }>(
      `SELECT id FROM tenet_machine WHERE enrollment_hash = $1 AND credential_hash = $2
       AND state = 'active' AND enrollment_expires > $3`,
      [digest, credentialHash, now],
    );
    if (!existing) throw new AuthError("INVALID_ENROLLMENT", 401);
    return { id: existing.id, first: false };
  }

  async identity(token: string) {
    if (!TOKEN.test(token))
      throw new AuthError("INVALID_MACHINE_CREDENTIAL", 401);
    const [row] = await this.sql.query<{ id: string }>(
      "SELECT id FROM tenet_machine WHERE credential_hash = $1 AND state = 'active'",
      [await hash(token)],
    );
    if (!row) throw new AuthError("INVALID_MACHINE_CREDENTIAL", 401);
    return row.id;
  }

  async ingest(id: string, data: Telemetry) {
    // Recheck revocation at the write, rather than trusting an earlier authentication read.
    const rows = await this.sql.query(
      "UPDATE tenet_machine SET last_seen = $1, telemetry = $2 WHERE id = $3 AND state = 'active' RETURNING id",
      [Date.now(), JSON.stringify(data), id],
    );
    if (!rows.length) throw new AuthError("INVALID_MACHINE_CREDENTIAL", 401);
  }

  async revoke(id: unknown) {
    if (typeof id !== "string" || id.length > 64)
      throw new AuthError("INVALID_ID");
    const rows = await this.sql.query(
      "UPDATE tenet_machine SET state = 'revoked', credential_hash = NULL, revoked_at = $1 WHERE id = $2 AND state <> 'revoked' RETURNING id",
      [Date.now(), id],
    );
    if (!rows.length) throw new AuthError("NOT_FOUND", 404);
  }

  async setProvider(id: unknown, value: unknown) {
    if (typeof id !== "string" || !id || id.length > 64)
      throw new AuthError("INVALID_ID");
    // Null means automatic detection. An omitted value is a malformed request.
    if (
      value !== null &&
      (typeof value !== "string" ||
        !value.trim() ||
        value.length > 60 ||
        hasControlCharacters(value))
    )
      throw new AuthError("INVALID_PROVIDER");
    const rows = await this.sql.query(
      "UPDATE tenet_machine SET provider_override = $1 WHERE id = $2 AND state <> 'revoked' RETURNING id",
      [typeof value === "string" ? value.trim() : null, id],
    );
    if (!rows.length) throw new AuthError("NOT_FOUND", 404);
  }

  async list() {
    const rows = await this.sql.query<MachineRow>(
      "SELECT id, name, state, created_at, enrollment_expires, last_seen, telemetry, updater_key, updater_seen, provider_override FROM tenet_machine ORDER BY created_at DESC",
    );
    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      providerOverride: row.provider_override,
      status:
        row.state === "revoked"
          ? "revoked"
          : row.state === "pending"
            ? Number(row.enrollment_expires) > now
              ? "pending"
              : "expired"
            : row.last_seen === null
              ? "connecting"
              : now - Number(row.last_seen) < OFFLINE_MS
                ? "online"
                : "offline",
      updaterKey: row.updater_key,
      updaterSeen: row.updater_seen === null ? null : Number(row.updater_seen),
      createdAt: Number(row.created_at),
      lastSeen: row.last_seen === null ? null : Number(row.last_seen),
      telemetry: row.telemetry
        ? (JSON.parse(row.telemetry) as Telemetry)
        : null,
    }));
  }
}

export type Machine = Awaited<ReturnType<MachineStore["list"]>>[number];
export interface MachineList {
  machines: Machine[];
  releaseInfo?: {
    configured: boolean;
    checkedAt: number;
    error: string | null;
    release?: import("./releases").ReleaseManifest;
    publicKey?: string;
    bootstrapCommand?: string;
  };
  updates?: import("./updates").UpdateJob[];
  installer: { available: boolean; architectures: string[]; https: boolean };
}
