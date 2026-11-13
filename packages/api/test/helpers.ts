import { Database } from "bun:sqlite";
import { afterEach, expect } from "bun:test";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { createApi } from "../src";
import type { AuthEnvironment } from "../src/auth/config";
import { AuthStore, OWNER_ID, type Sql } from "../src/auth/store";

export const origin = "http://localhost:3100";
const secret = "0123456789abcdef".repeat(4);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
export async function fixture() {
  let database: AuthEnvironment["database"];
  let sql: Sql;
  if (process.env.TEST_DATABASE_URL) {
    const schema = `test_${randomBytes(12).toString("hex")}`;
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    cleanup.push(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    });
    const directory = new URL("../migrations/postgres/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort())
      await pool.query(readFileSync(new URL(file, directory), "utf8"));
    database = pool;
    sql = {
      async query<T extends Record<string, unknown>>(
        query: string,
        values: unknown[] = [],
      ) {
        return (await pool.query<T>(query, values)).rows;
      },
    };
  } else {
    const db = new Database(":memory:");
    cleanup.push(() => db.close());
    db.exec("PRAGMA foreign_keys = ON");
    const directory = new URL("../migrations/sqlite/", import.meta.url);
    for (const file of readdirSync(directory)
      .filter((file) => file.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(new URL(file, directory), "utf8"));
    database = db;
    sql = {
      async query<T extends Record<string, unknown>>(
        query: string,
        values: unknown[] = [],
      ) {
        const ordered: (string | number | null)[] = [];
        const statement = query.replace(/\$(\d+)/g, (_, index: string) => {
          ordered.push(values[Number(index) - 1] as string | number | null);
          return "?";
        });
        return db.prepare(statement).all(...ordered) as T[];
      },
    };
  }
  const env: AuthEnvironment = { origin, secret, database, sql };
  return { sql, store: new AuthStore(sql), app: createApi(env), env };
}
export function timestamp(ms: number) {
  return process.env.TEST_DATABASE_URL ? new Date(ms).toISOString() : ms;
}
export class Browser {
  cookies = new Map<string, string>();
  constructor(public app: ReturnType<typeof createApi>) {}
  async request(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await this.app.request(`${origin}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const index = pair?.indexOf("=") ?? -1;
      if (pair && index > 0)
        this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
}
// Minimal test authenticator: real P-256 keys and signed WebAuthn data, not mocked verification.
function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) =>
    length < 24
      ? Buffer.from([major * 32 + length])
      : length < 256
        ? Buffer.from([major * 32 + 24, length])
        : Buffer.from([major * 32 + 25, length >> 8, length & 255]);
  if (typeof value === "number")
    return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([head(2, value.length), value]);
  const entries =
    value instanceof Map
      ? [...value]
      : Object.entries(value as Record<string, unknown>);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)]),
  ]);
}
export class SecurityKey {
  id = randomBytes(32);
  keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  counter = 0;
  client(challenge: string, type: string, site = origin) {
    return Buffer.from(
      JSON.stringify({ type, challenge, origin: site, crossOrigin: false }),
    );
  }
  registration(challenge: string, verified = true) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
    const authData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([verified ? 69 : 65]),
      Buffer.alloc(4),
      Buffer.alloc(16),
      Buffer.from([0, this.id.length]),
      this.id,
      cose,
    ]);
    return {
      id: this.id.toString("base64url"),
      rawId: this.id.toString("base64url"),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.client(challenge, "webauthn.create").toString(
          "base64url",
        ),
        attestationObject: cbor({
          fmt: "none",
          attStmt: {},
          authData,
        }).toString("base64url"),
        transports: ["internal"],
      },
    };
  }
  assertion(challenge: string, verified = true, site = origin) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([
      createHash("sha256").update("localhost").digest(),
      Buffer.from([verified ? 5 : 1]),
      count,
    ]);
    const client = this.client(challenge, "webauthn.get", site);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(client).digest()]),
      this.keys.privateKey,
    );
    return {
      id: this.id.toString("base64url"),
      rawId: this.id.toString("base64url"),
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: client.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: Buffer.from(OWNER_ID).toString("base64url"),
      },
    };
  }
}
export async function register(
  browser: Browser,
  key: SecurityKey,
  verified = true,
) {
  const options = await browser.request(
    "/auth/passkey/generate-register-options",
  );
  expect(options.status).toBe(200);
  const { challenge } = await options.json();
  return browser.request("/auth/passkey/verify-registration", {
    name: "Test key",
    createSession: true,
    response: key.registration(challenge, verified),
  });
}
export async function login(browser: Browser, key: SecurityKey) {
  const options = await browser.request(
    "/auth/passkey/generate-authenticate-options",
  );
  expect(options.status).toBe(200);
  const { challenge } = await options.json();
  return browser.request("/auth/passkey/verify-authentication", {
    response: key.assertion(challenge),
  });
}
export async function enrolled() {
  const f = await fixture();
  const browser = new Browser(f.app);
  const key = new SecurityKey();
  const code = await f.store.issueSetup();
  expect(
    (await browser.request("/setup/start", { code, name: "Owner" })).status,
  ).toBe(200);
  const response = await register(browser, key);
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain('"token":');
  return { ...f, browser, key };
}
