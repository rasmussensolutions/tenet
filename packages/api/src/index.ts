import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type AuthEnvironment,
  cookie,
  createAuth,
  grantCookieName,
  requireOwner,
  validateConfig,
} from "./auth/config";
import {
  AuthError,
  AuthStore,
  FRESH_MS,
  GRANT_MS,
  hash,
  OWNER_ID,
  randomToken,
} from "./auth/store";
import { Releases } from "./machines/releases";
import { Updates } from "./machines/updates";

export {
  type AuthEnvironment,
  createAuth,
  validateConfig,
} from "./auth/config";
export { AuthStore, type Sql } from "./auth/store";

import {
  installCommand,
  installer,
  releaseManifest,
  updaterCommand,
  updaterInstaller,
} from "./machines/installer";
import { MachineStore, telemetry } from "./machines/store";

const allowedAuth = new Map([
  ["/passkey/generate-register-options", "GET"],
  ["/passkey/verify-registration", "POST"],
  ["/passkey/generate-authenticate-options", "GET"],
  ["/passkey/verify-authentication", "POST"],
  ["/sign-out", "POST"],
]);

// Runtime adapters own infrastructure. Keep shared routes portable.
export function createApi(
  env: AuthEnvironment,
  clientIP: (request: Request) => string = () => "shared",
) {
  validateConfig(env);
  const app = new Hono();
  const store = new AuthStore(env.sql);
  const machines = new MachineStore(env.sql);
  const releases = new Releases(env.sql, env.releaseUrl, env.releasePublicKey);
  const updates = new Updates(env.sql, releases);

  app.onError((error, c) => {
    if (error instanceof SyntaxError)
      return c.json({ code: "INVALID_JSON" }, 400);
    if (error instanceof AuthError) {
      if (error.status === 429) c.header("Retry-After", "60");
      return c.json({ code: error.code }, error.status as 400);
    }
    console.error("Tenet API request failed", error.name);
    return c.json({ code: "INTERNAL_ERROR" }, 500);
  });
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    if (env.origin.startsWith("https:"))
      c.header("Strict-Transport-Security", "max-age=31536000");
    const origin = c.req.header("origin");
    if (
      (origin && origin !== env.origin) ||
      c.req.header("sec-fetch-site") === "cross-site"
    )
      throw new AuthError("INVALID_ORIGIN", 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      // Only these exact agent endpoints use bearer credentials rather than browser cookies.
      const agent = [
        "/api/agent/enroll",
        "/api/agent/telemetry",
        "/api/agent/updates/next",
        "/api/agent/updates/report",
        "/api/agent/updates/health",
      ].includes(c.req.path);
      if (!agent && origin !== env.origin)
        throw new AuthError("INVALID_ORIGIN", 403);
      if (
        c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      )
        throw new AuthError("JSON_REQUIRED", 415);
    }
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ code: "BODY_TOO_LARGE" }, 413),
    }),
  );
  app.use("/api/*", async (c, next) => {
    // Agent heartbeats have their own per-credential budget; fleets behind one NAT
    // must not consume the browser authentication budget.
    if (
      c.req.path === "/api/agent/telemetry" ||
      c.req.path.startsWith("/api/agent/updates/")
    )
      return next();
    const key = await hash(`${env.secret}:${clientIP(c.req.raw)}`);
    await store.limit(`api:${key}`, 180);
    if (["/api/setup/start", "/api/recovery/start"].includes(c.req.path)) {
      await store.limit(`recover:${key}`, 5);
      await store.limit("recover:global", 30);
    }
    if (c.req.path.startsWith("/api/auth/passkey/")) {
      await store.limit(`passkey:${key}`, 30);
      await store.limit("passkey:global", 120);
    }
    await next();
  });

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "tenet-api" }),
  );

  app.get("/api/setup/status", async (c) => {
    const { state } = await store.read();
    let enrolling = false;
    try {
      await store.grant(cookie(c.req.raw.headers, grantCookieName(env.origin)));
      enrolling = true;
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
    }
    return c.json({ configured: state.configured, enrolling });
  });

  for (const kind of ["setup", "recovery"] as const) {
    app.post(`/api/${kind}/start`, async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      if (typeof body.code !== "string" || body.code.length > 128)
        throw new AuthError("INVALID_OR_EXPIRED_CODE", 401);
      const name = typeof body.name === "string" ? body.name.trim() : "Owner";
      if (!name || name.length > 80) throw new AuthError("INVALID_NAME");
      let token: string;
      try {
        token = await store.start(kind, body.code.trim(), name);
      } catch (error) {
        await store.audit(`${kind}.rejected`);
        throw error;
      }
      const secure = env.origin.startsWith("https:") ? "; Secure" : "";
      c.header(
        "Set-Cookie",
        `${grantCookieName(env.origin)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${GRANT_MS / 1000}${secure}`,
      );
      c.header(
        "Set-Cookie",
        `${env.origin.startsWith("https:") ? "__Host-tenet" : "tenet"}.session_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`,
        { append: true },
      );
      return c.json({ ok: true });
    });
  }

  app.all("/api/auth/*", async (c) => {
    const path = c.req.path.slice("/api/auth".length);
    if (allowedAuth.get(path) !== c.req.method)
      return c.json({ code: "NOT_FOUND" }, 404);
    const auth = createAuth(env, c.req.raw.headers);
    let request = c.req.raw;
    if (path.includes("register") || path === "/passkey/verify-registration") {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      let context: string;
      if (session) {
        await requireOwner(auth, store, c.req.raw.headers, true);
        context = "session";
      } else
        context = (
          await store.grant(
            cookie(c.req.raw.headers, grantCookieName(env.origin)),
          )
        ).digest;
      if (c.req.method === "GET") {
        const url = new URL(c.req.url);
        url.searchParams.set("context", context);
        request = new Request(url, request);
      } else {
        const body = await c.req.json<Record<string, unknown>>();
        if (
          body.name !== undefined &&
          (typeof body.name !== "string" ||
            !body.name.trim() ||
            body.name.length > 80)
        )
          throw new AuthError("INVALID_NAME");
        // Enrollment always finishes with a session; a client cannot leave an owner half enrolled deliberately.
        if (!session) body.createSession = true;
        request = new Request(request, { body: JSON.stringify(body) });
      }
    }
    const response = await auth.handler(request);
    if (path === "/passkey/verify-authentication")
      await store.audit(
        response.ok ? "session.signed_in" : "session.sign_in_rejected",
      );
    if (path === "/sign-out" && response.ok)
      await store.audit("session.signed_out");
    // Tokens belong in HttpOnly cookies, never JSON available to frontend code.
    const data: unknown = await response.json();
    if (
      path === "/passkey/generate-register-options" &&
      response.ok &&
      typeof data === "object" &&
      data !== null &&
      "excludeCredentials" in data &&
      Array.isArray(data.excludeCredentials)
    ) {
      const { state } = await store.read();
      data.excludeCredentials = data.excludeCredentials.filter(
        (key: { id: string }) => state.credentials.includes(key.id),
      );
    }
    const sanitized = JSON.stringify(data, (key, value) =>
      key === "token" ? undefined : value,
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("cache-control", "no-store");
    if (path === "/passkey/verify-registration" && response.ok)
      headers.append(
        "set-cookie",
        `${grantCookieName(env.origin)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${env.origin.startsWith("https:") ? "; Secure" : ""}`,
      );
    return new Response(sanitized, { status: response.status, headers });
  });

  async function daemonRelease() {
    try {
      return releaseManifest(await env.loadDaemonRelease?.());
    } catch {
      throw new AuthError("DAEMON_NOT_AVAILABLE", 503);
    }
  }
  function bearer(header: string | undefined) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(header ?? "");
    if (!match?.[1]) throw new AuthError("INVALID_MACHINE_CREDENTIAL", 401);
    return match[1];
  }
  app.get("/api/agent/install.sh", async (c) => {
    c.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return c.body(
      installer(
        env.origin,
        await daemonRelease(),
        env.releaseUrl ? env.releasePublicKey : undefined,
      ),
    );
  });
  app.get("/api/agent/updater.sh", async (c) => {
    c.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return c.body(
      updaterInstaller(
        env.origin,
        await daemonRelease(),
        env.releaseUrl ? env.releasePublicKey : undefined,
      ),
    );
  });
  app.post("/api/agent/enroll", async (c) => {
    await store.limit("machine-enrollment:global", 30);
    const body = await c.req.json<{ credential?: unknown }>();
    if (!body || typeof body !== "object")
      throw new AuthError("INVALID_ENROLLMENT", 400);
    const result = await machines.enroll(
      bearer(c.req.header("authorization")),
      body.credential,
    );
    if (result.first) await store.audit("machine.enrolled", result.id);
    return c.json({ id: result.id, intervalSeconds: 15 });
  });
  app.post("/api/agent/telemetry", async (c) => {
    let id: string;
    try {
      id = await machines.identity(bearer(c.req.header("authorization")));
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      // Invalid credentials never allocate a rate bucket per attacker-controlled token.
      const key = await hash(`${env.secret}:${clientIP(c.req.raw)}`);
      await store.limit(`machine-invalid:${key}`, 30);
      throw error;
    }
    await store.limit(`machine:${id}`, 12);
    await machines.ingest(id, telemetry(await c.req.json()));
    return c.json({ ok: true });
  });

  for (const action of ["next", "report", "health"] as const) {
    app.post(`/api/agent/updates/${action}`, async (c) => {
      let id: string;
      try {
        id = await machines.identity(bearer(c.req.header("authorization")));
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        const key = await hash(`${env.secret}:${clientIP(c.req.raw)}`);
        await store.limit(`machine-invalid:${key}`, 30);
        throw error;
      }
      await store.limit(`updater:${id}`, 60);
      const body = await c.req.json();
      if (action === "next")
        return c.json({ job: await updates.next(id, body?.publicKey) });
      if (action === "report") {
        await updates.report(id, body);
        return c.json({ ok: true });
      }
      const [row] = await env.sql.query<{
        telemetry: string | null;
        last_seen: number;
      }>(
        "SELECT telemetry, last_seen FROM tenet_machine WHERE id = $1 AND state = 'active'",
        [id],
      );
      return c.json({
        telemetry: row?.telemetry ? JSON.parse(row.telemetry) : null,
        lastSeen: Number(row?.last_seen ?? 0),
      });
    });
  }

  // All future machine/service routes belong under this authenticated boundary.
  app.use("/api/*", async (c, next) => {
    await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
    );
    await next();
  });
  app.post("/api/machines/updates/check", async (c) => {
    await store.limit("release-check", 2);
    await releases.check(true);
    return c.json({ ok: true });
  });
  app.post("/api/machines/updates", async (c) => {
    await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
      true,
    );
    const body = await c.req.json();
    return c.json(await updates.queue(body?.id));
  });
  app.get("/api/machines", async (c) => {
    await releases.check();
    const { envelope: _envelope, ...releaseInfo } = await releases.read();
    let architectures: string[] = [];
    try {
      architectures = Object.keys(await daemonRelease()).filter(
        (key) => key !== "updaterProtocol",
      );
    } catch {
      /* Deployment has not bundled a daemon yet. */
    }
    return c.json({
      machines: await machines.list(),
      releaseInfo: {
        ...releaseInfo,
        publicKey: env.releasePublicKey,
        bootstrapCommand:
          releaseInfo.configured &&
          env.origin.startsWith("https:") &&
          (await daemonRelease().catch(() => null))?.updaterProtocol === 1
            ? updaterCommand(env.origin)
            : undefined,
      },
      updates: await updates.list(),
      installer: {
        available: architectures.length > 0 && env.origin.startsWith("https:"),
        architectures,
        https: env.origin.startsWith("https:"),
      },
    });
  });
  app.post("/api/machines/enrollments", async (c) => {
    await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
      true,
    );
    if (!env.origin.startsWith("https:"))
      throw new AuthError("HTTPS_REQUIRED", 409);
    await daemonRelease();
    await store.limit("machine-enrollment:issue", 10);
    const body = await c.req.json<{ name?: unknown }>();
    const result = await machines.create(body?.name);
    await store.audit("machine.enrollment_issued", result.id);
    return c.json({
      id: result.id,
      expiresAt: result.expiresAt,
      command: installCommand(env.origin, result.token),
    });
  });
  app.post("/api/machines/revoke", async (c) => {
    await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
      true,
    );
    const body = await c.req.json<{ id?: unknown }>();
    await machines.revoke(body?.id);
    await store.audit("machine.revoked", String(body.id));
    return c.json({ ok: true });
  });
  app.get("/api/session", async (c) => {
    const session = await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
    );
    const { state } = await store.read();
    return c.json({
      user: { id: session.user.id, name: session.user.name },
      session: {
        id: session.session.id,
        expiresAt: session.session.expiresAt,
        freshUntil: new Date(
          new Date(session.session.createdAt).getTime() + FRESH_MS,
        ).toISOString(),
      },
      recoveryCodesRemaining: state.recovery.length,
    });
  });
  app.get("/api/security", async (c) => {
    const session = await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
    );
    const { state } = await store.read();
    const keys = await env.sql.query(
      'SELECT id, name, "credentialID", "createdAt", "backedUp" FROM passkey WHERE "userId" = $1',
      [OWNER_ID],
    );
    const sessions = await env.sql.query(
      'SELECT id, "createdAt", "expiresAt", "userAgent" FROM session WHERE "userId" = $1 AND "authEpoch" = $2 ORDER BY "createdAt" DESC',
      [OWNER_ID, state.epoch],
    );
    const audit = await env.sql.query(
      "SELECT id, event, occurred_at FROM tenet_auth_audit ORDER BY occurred_at DESC LIMIT 50",
    );
    return c.json({
      passkeys: keys
        .filter((key) => state.credentials.includes(String(key.credentialID)))
        .map(({ credentialID: _credentialID, ...key }) => key),
      sessions: sessions
        .filter(
          (s) =>
            new Date(
              typeof s.expiresAt === "number"
                ? s.expiresAt
                : String(s.expiresAt),
            ).getTime() > Date.now(),
        )
        .map((s) => ({ ...s, current: s.id === session.session.id })),
      audit: audit.map((event) => ({
        ...event,
        occurred_at: Number(event.occurred_at),
      })),
      recoveryCodesRemaining: state.recovery.length,
    });
  });
  app.post("/api/security/recovery-codes", async (c) => {
    const session = await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
      true,
    );
    const codes = Array.from({ length: 8 }, () => randomToken(20));
    const hashes = await Promise.all(codes.map(hash));
    await store.change((s) => {
      if (s.epoch !== session.session.authEpoch)
        throw new AuthError("UNAUTHORIZED", 401);
      s.recovery = hashes;
    });
    await store.audit("recovery.codes_rotated");
    return c.json({ codes });
  });
  app.post("/api/security/passkeys/remove", async (c) => {
    const session = await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
      true,
    );
    const { id } = await c.req.json<{ id: unknown }>();
    if (typeof id !== "string" || id.length > 256)
      throw new AuthError("INVALID_ID");
    const [key] = await env.sql.query<{ credentialID: string }>(
      'SELECT "credentialID" FROM passkey WHERE id = $1 AND "userId" = $2',
      [id, OWNER_ID],
    );
    if (!key) throw new AuthError("NOT_FOUND", 404);
    const registered = await env.sql.query<{ credentialID: string }>(
      'SELECT "credentialID" FROM passkey WHERE "userId" = $1',
      [OWNER_ID],
    );
    const epoch = await store.change((s) => {
      if (s.epoch !== session.session.authEpoch)
        throw new AuthError("UNAUTHORIZED", 401);
      if (!s.credentials.includes(key.credentialID))
        throw new AuthError("NOT_FOUND", 404);
      if (
        registered.filter((row) => s.credentials.includes(row.credentialID))
          .length < 2
      )
        throw new AuthError("LAST_PASSKEY", 409);
      s.credentials = s.credentials.filter((v) => v !== key.credentialID);
      s.epoch++;
      return s.epoch;
    });
    // Preserve only the session authorizing this operation. Older in-flight proofs
    // and all other sessions keep the old epoch and are immediately unauthorized.
    await env.sql.query(
      'UPDATE session SET "authEpoch" = $1 WHERE id = $2 AND "authEpoch" = $3',
      [epoch, session.session.id, session.session.authEpoch],
    );
    await env.sql.query('DELETE FROM passkey WHERE id = $1 AND "userId" = $2', [
      id,
      OWNER_ID,
    ]);
    await store.audit("passkey.removed", id);
    return c.json({ ok: true });
  });
  app.post("/api/security/sessions/revoke", async (c) => {
    const session = await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
      true,
    );
    const { id } = await c.req.json<{ id: unknown }>();
    if (typeof id !== "string" || id.length > 256)
      throw new AuthError("INVALID_ID");
    if (id === "others")
      await env.sql.query(
        'DELETE FROM session WHERE "userId" = $1 AND id <> $2',
        [OWNER_ID, session.session.id],
      );
    else
      await env.sql.query(
        'DELETE FROM session WHERE "userId" = $1 AND id = $2',
        [OWNER_ID, id],
      );
    await store.audit("session.revoked");
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json({ code: "NOT_FOUND" }, 404));
  return app;
}
