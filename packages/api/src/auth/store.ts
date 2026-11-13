/** Small SQL surface shared by PostgreSQL and D1. Parameters use PostgreSQL notation. */
export interface Sql {
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<T[]>;
}

export const OWNER_ID = "tenet-owner";
export const FRESH_MS = 5 * 60_000;
export const GRANT_MS = 10 * 60_000;

export class AuthError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}

export interface AuthState {
  configured: boolean;
  name: string;
  epoch: number;
  credentials: string[];
  recovery: string[];
  setup?: { hash: string; expires: number };
  grant?: { hash: string; expires: number; epoch: number };
}

export function randomToken(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export class AuthStore {
  constructor(public sql: Sql) {}

  async read() {
    const [row] = await this.sql.query<{ data: string; revision: number }>(
      "SELECT data, revision FROM tenet_auth_state WHERE id = 1",
    );
    if (!row)
      throw new Error(
        "Authentication database has not been initialized. Run the migrations.",
      );
    return { state: JSON.parse(row.data) as AuthState, revision: row.revision };
  }

  /** One atomic compare-and-swap protects single-use secrets and the last passkey across replicas. */
  async change<T>(change: (state: AuthState) => T): Promise<T> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { state, revision } = await this.read();
      const result = change(state);
      const rows = await this.sql.query(
        "UPDATE tenet_auth_state SET data = $1, revision = revision + 1 WHERE id = 1 AND revision = $2 RETURNING revision",
        [JSON.stringify(state), revision],
      );
      if (rows.length) return result;
    }
    throw new AuthError("PLEASE_RETRY", 409);
  }

  async issueSetup() {
    const token = randomToken();
    const digest = await hash(token);
    await this.change((s) => {
      if (s.configured) throw new AuthError("ALREADY_CONFIGURED", 409);
      s.setup = { hash: digest, expires: Date.now() + 30 * 60_000 };
      delete s.grant;
    });
    await this.audit("setup.issued");
    return token;
  }

  async issueRecovery() {
    const code = randomToken(20);
    const digest = await hash(code);
    await this.change((s) => {
      if (!s.configured) throw new AuthError("NOT_CONFIGURED", 409);
      // Deployment administrators can recover even after an interrupted registration.
      s.recovery = [digest];
    });
    await this.audit("recovery.operator_issued");
    return code;
  }

  async start(kind: "setup" | "recovery", token: string, name: string) {
    const digest = await hash(token);
    const grant = randomToken();
    const grantHash = await hash(grant);
    await this.change((s) => {
      if (kind === "setup") {
        if (
          s.configured ||
          !s.setup ||
          s.setup.expires <= Date.now() ||
          s.setup.hash !== digest
        )
          throw new AuthError("INVALID_OR_EXPIRED_CODE", 401);
        s.name = name;
        delete s.setup;
      } else {
        if (!s.configured || !s.recovery.includes(digest))
          throw new AuthError("INVALID_OR_EXPIRED_CODE", 401);
        s.recovery = s.recovery.filter((v) => v !== digest);
        s.epoch++;
        s.credentials = [];
      }
      s.grant = {
        hash: grantHash,
        expires: Date.now() + GRANT_MS,
        epoch: s.epoch,
      };
    });
    await this.audit(`${kind}.started`);
    return grant;
  }

  async grant(token: string | undefined) {
    const digest = await hash(token ?? "");
    const { state } = await this.read();
    if (
      !state.grant ||
      state.grant.hash !== digest ||
      state.grant.expires <= Date.now() ||
      state.grant.epoch !== state.epoch
    )
      throw new AuthError("SETUP_OR_RECOVERY_REQUIRED", 401);
    return { digest, state };
  }

  async audit(event: string, subject: string | null = null) {
    await this.sql.query(
      "INSERT INTO tenet_auth_audit (id, event, subject, occurred_at) VALUES ($1, $2, $3, $4)",
      [crypto.randomUUID(), event, subject, Date.now()],
    );
  }

  async limit(key: string, maximum: number, windowMs = 60_000) {
    const now = Date.now();
    const [row] = await this.sql.query<{ hits: number }>(
      `INSERT INTO tenet_auth_rate (key, hits, reset_at) VALUES ($1, 1, $2)
      ON CONFLICT (key) DO UPDATE SET hits = CASE WHEN tenet_auth_rate.reset_at <= $3 THEN 1 ELSE tenet_auth_rate.hits + 1 END,
      reset_at = CASE WHEN tenet_auth_rate.reset_at <= $3 THEN $2 ELSE tenet_auth_rate.reset_at END RETURNING hits`,
      [key, now + windowMs, now],
    );
    if (!row || row.hits > maximum)
      throw new AuthError("TOO_MANY_ATTEMPTS", 429);
  }
}
