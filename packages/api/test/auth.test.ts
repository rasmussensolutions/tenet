import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createApi } from "../src";
import { validateConfig } from "../src/auth/config";
import { hash } from "../src/auth/store";
import {
  Browser,
  enrolled,
  fixture,
  login,
  origin,
  register,
  SecurityKey,
  timestamp,
} from "./helpers";

describe("configuration and HTTP boundary", () => {
  test("requires a fixed secure origin and a strong deployment secret", async () => {
    const f = await fixture();
    for (const bad of [
      "http://example.com",
      "https://example.com/path",
      "https://example.com/",
      "https://u:p@example.com",
    ])
      expect(() => validateConfig({ ...f.env, origin: bad })).toThrow();
    expect(() => validateConfig({ ...f.env, secret: "weak" })).toThrow();
  });
  test("rejects unauthenticated, cross-origin, oversized and unexposed auth requests", async () => {
    const { app } = await fixture();
    const b = new Browser(app);
    expect((await b.request("/security")).status).toBe(401);
    expect((await b.request("/machines")).status).toBe(401);
    expect((await b.request("/auth/sign-up/email", {})).status).toBe(404);
    expect((await b.request("/auth/delete-user", {})).status).toBe(404);
    expect(
      (
        await b.request(
          "/auth/sign-out",
          {},
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await b.request("/auth/sign-out", {}, { origin: "null" })).status,
    ).toBe(403);
    expect(
      (await b.request("/auth/sign-out", {}, { "content-type": "text/plain" }))
        .status,
    ).toBe(415);
    expect(
      (await b.request("/setup/start", { code: "x".repeat(33_000) })).status,
    ).toBe(413);
    expect(
      (await b.request("/auth/passkey/generate-register-options")).status,
    ).toBe(401);
  });
  test("rate limits are durable across API instances and ignore spoofed forwarding headers", async () => {
    const f = await fixture();
    const b = new Browser(f.app);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await b.request(
            "/setup/start",
            { code: "bad" },
            { "x-forwarded-for": `192.0.2.${i}` },
          )
        ).status,
      ).toBe(401);
    const other = new Browser(createApi(f.env));
    expect((await other.request("/setup/start", { code: "bad" })).status).toBe(
      429,
    );
  });
});
describe("single-use setup and recovery", () => {
  test("setup code is hashed, expiring and atomically single use", async () => {
    const { store, app } = await fixture();
    const code = await store.issueSetup();
    expect(JSON.stringify((await store.read()).state)).not.toContain(code);
    const b = new Browser(app);
    const results = await Promise.all([
      b.request("/setup/start", { code }),
      new Browser(app).request("/setup/start", { code }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    const next = await store.issueSetup();
    await store.change((s) => {
      if (s.setup) s.setup.expires = Date.now() - 1;
    });
    expect((await b.request("/setup/start", { code: next })).status).toBe(401);
  });
  test("registration requires user verification and consumes the challenge on failure", async () => {
    const { store, app } = await fixture();
    const b = new Browser(app);
    await b.request("/setup/start", { code: await store.issueSetup() });
    const options = await (
      await b.request("/auth/passkey/generate-register-options")
    ).json();
    const key = new SecurityKey();
    expect(
      (
        await b.request("/auth/passkey/verify-registration", {
          response: key.registration(options.challenge, false),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await b.request("/auth/passkey/verify-registration", {
          response: key.registration(options.challenge),
        })
      ).status,
    ).toBe(400);
    expect((await store.read()).state.configured).toBe(false);
  });
  test("recovery revokes old sessions and keys immediately; code cannot be replayed", async () => {
    const { store, browser, key, app } = await enrolled();
    const codes = await (
      await browser.request("/security/recovery-codes", {})
    ).json();
    expect(codes.codes).toHaveLength(8);
    const replacement = new Browser(app);
    expect(
      (await replacement.request("/recovery/start", { code: codes.codes[0] }))
        .status,
    ).toBe(200);
    expect((await browser.request("/session")).status).toBe(401);
    expect(
      (
        await new Browser(app).request("/recovery/start", {
          code: codes.codes[0],
        })
      ).status,
    ).toBe(401);
    expect((await login(new Browser(app), key)).status).toBe(401);
    const nextKey = new SecurityKey();
    expect((await register(replacement, nextKey)).status).toBe(200);
    expect((await replacement.request("/session")).status).toBe(200);
    expect((await store.read()).state.credentials).toEqual([
      nextKey.id.toString("base64url"),
    ]);
  });
  test("registration challenge is bound to the enrollment grant", async () => {
    const { store, app } = await fixture();
    const first = new Browser(app);
    const second = new Browser(app);
    await first.request("/setup/start", { code: await store.issueSetup() });
    const options = await (
      await first.request("/auth/passkey/generate-register-options")
    ).json();
    await second.request("/setup/start", { code: await store.issueSetup() });
    for (const [k, v] of first.cookies)
      if (k.includes("challenge")) second.cookies.set(k, v);
    expect(
      (
        await second.request("/auth/passkey/verify-registration", {
          response: new SecurityKey().registration(options.challenge),
        })
      ).status,
    ).not.toBe(200);
  });
});
describe("sessions and credential management", () => {
  test("sign-in requires real signatures, correct origin and UV; challenges cannot be reused", async () => {
    const { app, key } = await enrolled();
    const b = new Browser(app);
    for (const [uv, site] of [
      [false, origin],
      [true, "https://evil.example"],
    ] as const) {
      const options = await (
        await b.request("/auth/passkey/generate-authenticate-options")
      ).json();
      expect(
        (
          await b.request("/auth/passkey/verify-authentication", {
            response: key.assertion(options.challenge, uv, site),
          })
        ).status,
      ).not.toBe(200);
    }
    const options = await (
      await b.request("/auth/passkey/generate-authenticate-options")
    ).json();
    const response = key.assertion(options.challenge);
    expect(
      (await b.request("/auth/passkey/verify-authentication", { response }))
        .status,
    ).toBe(200);
    expect(
      (await b.request("/auth/passkey/verify-authentication", { response }))
        .status,
    ).not.toBe(200);
    const session = await b.request("/session");
    expect(session.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await session.json())).not.toContain('"token":');
  });
  test("last passkey cannot be removed, even concurrently", async () => {
    const { browser, store } = await enrolled();
    const second = new SecurityKey();
    expect((await register(browser, second)).status).toBe(200);
    const { passkeys } = await (await browser.request("/security")).json();
    const responses = await Promise.all(
      passkeys.map((key: { id: string }) =>
        browser.request("/security/passkeys/remove", { id: key.id }),
      ),
    );
    expect(responses.filter((r: Response) => r.status === 200)).toHaveLength(1);
    expect(
      responses.every((r: Response) => [200, 401, 409].includes(r.status)),
    ).toBe(true);
    expect((await store.read()).state.credentials).toHaveLength(1);
  });
  test("revocation and sign-out invalidate database sessions immediately", async () => {
    const { browser, app, key } = await enrolled();
    const other = new Browser(app);
    expect((await login(other, key)).status).toBe(200);
    expect((await other.request("/session")).status).toBe(200);
    expect(
      (await browser.request("/security/sessions/revoke", { id: "others" }))
        .status,
    ).toBe(200);
    expect((await other.request("/session")).status).toBe(401);
    const stolenCookies = new Map(browser.cookies);
    expect((await browser.request("/auth/sign-out", {})).status).toBe(200);
    browser.cookies = stolenCookies;
    expect((await browser.request("/session")).status).toBe(401);
  });
  test("expired or tampered sessions fail; sensitive operations require fresh authentication", async () => {
    const { browser, sql } = await enrolled();
    await sql.query('UPDATE session SET "createdAt" = $1', [
      timestamp(Date.now() - 360_000),
    ]);
    expect((await browser.request("/security/recovery-codes", {})).status).toBe(
      403,
    );
    expect(
      (await browser.request("/auth/passkey/generate-register-options")).status,
    ).toBe(403);
    expect((await browser.request("/session")).status).toBe(200);
    await sql.query('UPDATE session SET "expiresAt" = $1', [
      timestamp(Date.now() - 1),
    ]);
    expect((await browser.request("/session")).status).toBe(401);
    browser.cookies.set("tenet.session_token", "forged.signature");
    expect((await browser.request("/session")).status).toBe(401);
  });
  test("epoch races cannot create an authorized session with an old proof", async () => {
    const { browser, store } = await enrolled();
    await store.change((s) => {
      s.epoch++;
    });
    expect((await browser.request("/session")).status).toBe(401);
    expect(
      (await browser.request("/security/passkeys/remove", { id: "anything" }))
        .status,
    ).toBe(401);
  });
  test("rotating recovery codes invalidates all previous codes", async () => {
    const { browser, store } = await enrolled();
    const first = await (
      await browser.request("/security/recovery-codes", {})
    ).json();
    const second = await (
      await browser.request("/security/recovery-codes", {})
    ).json();
    const { state } = await store.read();
    expect(state.recovery).not.toContain(await hash(first.codes[0]));
    expect(state.recovery).toContain(await hash(second.codes[0]));
  });
});

describe("regression and race checks", () => {
  test("production enrollment cookies are host-only, HttpOnly, Secure and strict", async () => {
    const f = await fixture();
    const secureOrigin = "https://panel.example.test";
    const b = new Browser(createApi({ ...f.env, origin: secureOrigin }));
    const response = await b.request(
      "/setup/start",
      { code: await f.store.issueSetup() },
      { origin: secureOrigin },
    );
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBe(2);
    for (const value of cookies) {
      expect(value).toStartWith("__Host-tenet.");
      expect(value).toContain("HttpOnly");
      expect(value).toContain("Secure");
      expect(value).toContain("SameSite=Strict");
      expect(value).toContain("Path=/");
      expect(value).not.toContain("Domain=");
    }
  });
  test("expired enrollment grants cannot authorize registration", async () => {
    const f = await fixture();
    const b = new Browser(f.app);
    await b.request("/setup/start", { code: await f.store.issueSetup() });
    await f.store.change((s) => {
      if (s.grant) s.grant.expires = Date.now() - 1;
    });
    expect(
      (await b.request("/auth/passkey/generate-register-options")).status,
    ).toBe(401);
  });
  test("a revoked credential ID cannot be reauthorized by a failed duplicate registration", async () => {
    const f = await enrolled();
    const code = await f.store.issueRecovery();
    const b = new Browser(f.app);
    await b.request("/recovery/start", { code });
    const options = await (
      await b.request("/auth/passkey/generate-register-options")
    ).json();
    expect(options.excludeCredentials).toHaveLength(0);
    const duplicate = new SecurityKey();
    duplicate.id = f.key.id;
    const response = await b.request("/auth/passkey/verify-registration", {
      response: duplicate.registration(options.challenge),
    });
    expect(response.status).toBe(409);
    expect((await f.store.read()).state.credentials).toHaveLength(0);
    expect((await login(new Browser(f.app), f.key)).status).toBe(401);
    expect((await register(b, new SecurityKey())).status).toBe(200);
  });
  test("removing a credential revokes other sessions and keeps the initiating session", async () => {
    const f = await enrolled();
    const backup = new SecurityKey();
    expect((await register(f.browser, backup)).status).toBe(200);
    const other = new Browser(f.app);
    expect((await login(other, f.key)).status).toBe(200);
    const { passkeys } = await (await f.browser.request("/security")).json();
    expect(
      (
        await f.browser.request("/security/passkeys/remove", {
          id: passkeys[0].id,
        })
      ).status,
    ).toBe(200);
    expect((await other.request("/session")).status).toBe(401);
    expect((await f.browser.request("/session")).status).toBe(200);
  });
  test("a forged signature is rejected and a valid challenge can only succeed once concurrently", async () => {
    const f = await enrolled();
    const b = new Browser(f.app);
    const options = await (
      await b.request("/auth/passkey/generate-authenticate-options")
    ).json();
    const bad = f.key.assertion(options.challenge);
    bad.response.signature = randomBytes(64).toString("base64url");
    expect(
      (
        await b.request("/auth/passkey/verify-authentication", {
          response: bad,
        })
      ).status,
    ).not.toBe(200);
    const next = await (
      await b.request("/auth/passkey/generate-authenticate-options")
    ).json();
    const assertion = f.key.assertion(next.challenge);
    const second = new Browser(createApi(f.env));
    second.cookies = new Map(b.cookies);
    const replies = await Promise.all([
      b.request("/auth/passkey/verify-authentication", { response: assertion }),
      second.request("/auth/passkey/verify-authentication", {
        response: assertion,
      }),
    ]);
    expect(replies.filter((r) => r.status === 200)).toHaveLength(1);
  });
});
