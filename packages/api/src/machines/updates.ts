import { AuthError, AuthStore, type Sql } from "../auth/store";
import { HEX_KEY, newer, type Releases } from "./releases";

export interface UpdateJob {
  id: string;
  machine_id: string;
  version: string;
  build_id: string;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}
export class Updates {
  constructor(
    private sql: Sql,
    private releases: Releases,
  ) {}
  async queue(machineId: unknown) {
    if (typeof machineId !== "string" || machineId.length > 64)
      throw new AuthError("INVALID_ID");
    const latest = await this.releases.read();
    if (!latest.release || !latest.envelope)
      throw new AuthError("NO_VERIFIED_RELEASE", 409);
    const rows = await this.sql.query<{
      telemetry: string;
      updater_key: string;
      updater_seen: number;
    }>(
      "SELECT telemetry, updater_key, updater_seen FROM tenet_machine WHERE id = $1 AND state = 'active'",
      [machineId],
    );
    const machine = rows[0];
    if (
      !machine ||
      machine.updater_key !== this.releases.publicKey ||
      Number(machine.updater_seen) < Date.now() - 180000
    )
      throw new AuthError("UPDATER_BOOTSTRAP_REQUIRED", 409);
    const current = JSON.parse(machine.telemetry || "{}");
    if (
      !latest.release.artifacts[current.arch as "x86_64"] ||
      !newer(latest.release.version, current.agentVersion || "0.0.0")
    )
      throw new AuthError("NO_COMPATIBLE_UPDATE", 409);
    await this.expire();
    const id = crypto.randomUUID();
    const now = Date.now();
    const inserted = await this.sql.query(
      `INSERT INTO tenet_update (id, machine_id, envelope, version, build_id, status, created_at, updated_at, expires_at)
      SELECT $1, id, $3, $4, $5, 'queued', $6, $6, $7 FROM tenet_machine WHERE id = $2 AND state = 'active' ON CONFLICT DO NOTHING RETURNING id`,
      [
        id,
        machineId,
        JSON.stringify(latest.envelope),
        latest.release.version,
        latest.release.buildId,
        now,
        now + 15 * 60000,
      ],
    );
    if (!inserted.length) throw new AuthError("UPDATE_ALREADY_RUNNING", 409);
    await new AuthStore(this.sql).audit("machine.update_requested", machineId);
    return { id };
  }
  async expire() {
    await this.sql.query(
      "UPDATE tenet_update SET status = 'expired', error = 'No completion received before the deadline; inspect the VPS before retrying.', updated_at = $1 WHERE status IN ('queued','downloading','installing') AND expires_at <= $1",
      [Date.now()],
    );
  }
  async next(machineId: string, key: unknown) {
    if (typeof key !== "string" || !HEX_KEY.test(key))
      throw new AuthError("INVALID_UPDATER");
    await this.sql.query(
      "UPDATE tenet_machine SET updater_key = $1, updater_seen = $2 WHERE id = $3 AND state = 'active'",
      [key, Date.now(), machineId],
    );
    await this.expire();
    const [job] = await this.sql.query<{
      id: string;
      envelope: string;
      expires_at: number;
    }>(
      "SELECT id, envelope, expires_at FROM tenet_update WHERE machine_id = $1 AND EXISTS (SELECT 1 FROM tenet_machine WHERE id = $1 AND state = 'active') AND status IN ('queued','downloading','installing') ORDER BY created_at DESC LIMIT 1",
      [machineId],
    );
    return job
      ? {
          id: job.id,
          envelope: JSON.parse(job.envelope),
          expiresAt: Number(job.expires_at),
        }
      : null;
  }
  async report(
    machineId: string,
    body: { id?: unknown; status?: unknown; error?: unknown },
  ) {
    if (
      typeof body?.id !== "string" ||
      body.id.length > 64 ||
      ![
        "downloading",
        "installing",
        "succeeded",
        "rolled_back",
        "failed",
      ].includes(String(body.status))
    )
      throw new AuthError("INVALID_UPDATE_REPORT");
    const error = body.error == null ? null : String(body.error).slice(0, 200);
    const terminal = ["succeeded", "rolled_back", "failed"].includes(
      String(body.status),
    );
    // Never move backwards or reopen a terminal job. Late terminal receipts resolve an
    // expired request; keeping the same receipt idempotent survives lost responses.
    const allowed =
      body.status === "downloading"
        ? ["queued"]
        : body.status === "installing"
          ? ["downloading"]
          : body.status === "succeeded"
            ? ["installing", "expired"]
            : ["queued", "downloading", "installing", "expired"];
    const rows = await this.sql.query(
      `UPDATE tenet_update SET status = $1, error = $2, updated_at = $3 WHERE id = $4 AND machine_id = $5 AND EXISTS (SELECT 1 FROM tenet_machine WHERE id = $5 AND state = 'active') AND status IN (${allowed.map((_, index) => `$${index + 6}`).join(",")}) RETURNING id`,
      [body.status, error, Date.now(), body.id, machineId, ...allowed],
    );
    if (rows.length && terminal)
      await new AuthStore(this.sql).audit(
        `machine.update_${body.status}`,
        machineId,
      );
    if (!rows.length) {
      const [existing] = await this.sql.query<{ status: string }>(
        "SELECT status FROM tenet_update WHERE id = $1 AND machine_id = $2 AND EXISTS (SELECT 1 FROM tenet_machine WHERE id = $2 AND state = 'active')",
        [body.id, machineId],
      );
      if (!existing || existing.status !== body.status)
        throw new AuthError("UPDATE_NOT_ACTIVE", 409);
    }
  }

  async list() {
    await this.expire();
    const rows = await this.sql.query<UpdateJob & Record<string, unknown>>(
      "SELECT id, machine_id, version, build_id, status, error, created_at, updated_at FROM tenet_update ORDER BY created_at DESC LIMIT 1000",
    );
    return rows.map((row) => ({
      ...row,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }));
  }
}
