import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { createApi } from "../src";
import { randomToken } from "../src/auth/store";
import { installer, updaterInstaller } from "../src/machines/installer";
import { Releases, verifyRelease } from "../src/machines/releases";
import { MachineStore } from "../src/machines/store";
import { Updates } from "../src/machines/updates";
import { Browser, enrolled, timestamp } from "./helpers";

const keys = generateKeyPairSync("ed25519");
const publicKey = Buffer.from(
  keys.publicKey.export({ format: "jwk" }).x ?? "",
  "base64url",
).toString("hex");
function signed(changes = {}) {
  const manifest = JSON.stringify({
    schema: 1,
    version: "0.2.0",
    buildId: "a".repeat(64),
    protocol: 1,
    updaterProtocol: 1,
    channel: "stable",
    expiresAt: Date.now() + 86400000,
    artifacts: {
      x86_64: {
        url: "https://example.com/0.2.0/tenetd",
        sha256: "b".repeat(64),
        size: 100,
      },
    },
    ...changes,
  });
  return {
    manifest,
    signature: sign(null, Buffer.from(manifest), keys.privateKey).toString(
      "hex",
    ),
  };
}
const sample = {
  version: 1 as const,
  hostname: "vps",
  os: "Linux",
  arch: "x86_64",
  agentVersion: "0.1.0",
  cpuCount: 1,
  cpuPercent: 1,
  memoryTotal: 1024,
  memoryUsed: 128,
  uptime: 1,
  disks: [],
};
async function ready() {
  const f = await enrolled();
  const env = {
    ...f.env,
    releaseUrl: "https://example.com/release.json",
    releasePublicKey: publicKey,
  };
  const app = createApi(env);
  const browser = new Browser(app);
  browser.cookies = f.browser.cookies;
  const machines = new MachineStore(f.sql);
  const enrollment = await machines.create("VPS");
  const credential = randomToken();
  await machines.enroll(enrollment.token, credential);
  await machines.ingest(enrollment.id, sample);
  const envelope = signed();
  await f.sql.query(
    "UPDATE tenet_release SET envelope=$1, checked_at=$2, next_check=$3 WHERE id=1",
    [JSON.stringify(envelope), Date.now(), Date.now() + 900000],
  );
  const releases = new Releases(f.sql, env.releaseUrl, publicKey);
  const updates = new Updates(f.sql, releases);
  await updates.next(enrollment.id, publicKey);
  const agent = (path: string, body: unknown, token = credential) =>
    app.request(`/api/agent/updates/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  return {
    ...f,
    app,
    browser,
    machines,
    enrollment,
    credential,
    releases,
    updates,
    agent,
    envelope,
  };
}
describe("signed daemon updates", () => {
  test("verifies exact bytes, rejects tampering, wrong keys, expiry and incompatible metadata", async () => {
    expect((await verifyRelease(signed(), publicKey)).release.version).toBe(
      "0.2.0",
    );
    const tampered = signed();
    tampered.manifest += " ";
    await expect(verifyRelease(tampered, publicKey)).rejects.toThrow();
    await expect(verifyRelease(signed(), "c".repeat(64))).rejects.toThrow();
    for (const changes of [
      { expiresAt: 1 },
      { protocol: 2 },
      { updaterProtocol: 2 },
      { version: "01.2.3" },
      { artifacts: {} },
      {
        artifacts: {
          x86_64: {
            url: "http://evil.test/a",
            sha256: "a".repeat(64),
            size: 100,
          },
        },
      },
      {
        artifacts: {
          x86_64: {
            url: "https://a.test/a",
            sha256: "a".repeat(64),
            size: 32 * 1024 * 1024 + 1,
          },
        },
      },
    ])
      await expect(verifyRelease(signed(changes), publicKey)).rejects.toThrow();
  });
  test("owner request flows through durable queue, authenticated polling, progress and completion", async () => {
    const f = await ready();
    const response = await f.browser.request("/machines/updates", {
      id: f.enrollment.id,
    });
    expect(response.status).toBe(200);
    const { id } = await response.json();
    const poll = await f.agent("next", { publicKey });
    expect(poll.status).toBe(200);
    expect((await poll.json()).job).toMatchObject({ id, envelope: f.envelope });
    for (const status of [
      "downloading",
      "installing",
      "succeeded",
      "succeeded",
    ])
      expect((await f.agent("report", { id, status })).status).toBe(200);
    expect(
      (await f.agent("report", { id, status: "downloading" })).status,
    ).toBe(409);
    expect(
      (await (await f.agent("next", { publicKey })).json()).job,
    ).toBeNull();
    const list = await (await f.browser.request("/machines")).json();
    expect(list.updates[0]).toMatchObject({ id, status: "succeeded" });
    expect(JSON.stringify(list)).not.toContain(f.credential);
    expect(JSON.stringify(list)).not.toContain(f.envelope.signature);
    const audit = await f.sql.query<{ event: string }>(
      "SELECT event FROM tenet_auth_audit WHERE subject=$1",
      [f.enrollment.id],
    );
    expect(audit.map((row) => row.event)).toEqual([
      "machine.update_requested",
      "machine.update_succeeded",
    ]);
  });
  test("requires owner session, CSRF protection and a fresh passkey", async () => {
    const f = await ready();
    expect(
      (
        await new Browser(f.app).request("/machines/updates", {
          id: f.enrollment.id,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.app.request("/api/machines/updates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: f.enrollment.id }),
        })
      ).status,
    ).toBe(403);
    await f.sql.query('UPDATE session SET "createdAt"=$1', [
      timestamp(Date.now() - 360000),
    ]);
    expect(
      (await f.browser.request("/machines/updates", { id: f.enrollment.id }))
        .status,
    ).toBe(403);
    expect(
      (await f.browser.request("/agent/updates/next", { publicKey })).status,
    ).toBe(401);
  });
  test("serializes concurrent requests and isolates machines, including revocation", async () => {
    const f = await ready();
    const results = await Promise.all([
      f.browser.request("/machines/updates", { id: f.enrollment.id }),
      f.browser.request("/machines/updates", { id: f.enrollment.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const id = (await f.updates.list())[0]?.id;
    const other = await f.machines.create("Other");
    const credential = randomToken();
    await f.machines.enroll(other.token, credential);
    expect(
      (await (await f.agent("next", { publicKey }, credential)).json()).job,
    ).toBeNull();
    expect(
      (await f.agent("report", { id, status: "failed" }, credential)).status,
    ).toBe(409);
    expect((await f.agent("report", { id, status: "succeeded" })).status).toBe(
      409,
    );
    await f.machines.revoke(f.enrollment.id);
    expect((await f.agent("next", { publicKey })).status).toBe(401);
    expect((await f.agent("report", { id, status: "failed" })).status).toBe(
      401,
    );
  });
  test("rejects downgrade, unsupported architecture and missing/stale/mismatched updater", async () => {
    const f = await ready();
    for (const changed of [
      { agentVersion: "0.2.0" },
      { agentVersion: "0.3.0" },
      { arch: "s390x" },
    ]) {
      await f.machines.ingest(f.enrollment.id, { ...sample, ...changed });
      await expect(f.updates.queue(f.enrollment.id)).rejects.toThrow(
        "NO_COMPATIBLE_UPDATE",
      );
    }
    await f.machines.ingest(f.enrollment.id, sample);
    await f.updates.next(f.enrollment.id, "f".repeat(64));
    await expect(f.updates.queue(f.enrollment.id)).rejects.toThrow(
      "UPDATER_BOOTSTRAP_REQUIRED",
    );
    await f.updates.next(f.enrollment.id, publicKey);
    await f.sql.query("UPDATE tenet_machine SET updater_seen=1 WHERE id=$1", [
      f.enrollment.id,
    ]);
    await expect(f.updates.queue(f.enrollment.id)).rejects.toThrow(
      "UPDATER_BOOTSTRAP_REQUIRED",
    );
  });
  test("expiry stops dispatch, late rollback receipts reconcile without being replayed", async () => {
    const f = await ready();
    const { id } = await f.updates.queue(f.enrollment.id);
    await f.sql.query("UPDATE tenet_update SET expires_at=1 WHERE id=$1", [id]);
    expect(await f.updates.next(f.enrollment.id, publicKey)).toBeNull();
    expect((await f.updates.list())[0]?.status).toBe("expired");
    await f.updates.report(f.enrollment.id, { id, status: "rolled_back" });
    await f.updates.report(f.enrollment.id, { id, status: "rolled_back" });
    await expect(
      f.updates.report(f.enrollment.id, { id, status: "installing" }),
    ).rejects.toThrow();
    expect((await f.updates.list())[0]?.status).toBe("rolled_back");
  });
  test("bootstrap pins trust, keeps monitoring unprivileged, and generates valid shell", async () => {
    const monitoringScript = installer("https://panel.example.com", {
      x86_64: "a".repeat(64),
    });
    expect(monitoringScript).toContain(
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
    );
    expect(monitoringScript).toContain("User=tenetd");
    expect(monitoringScript).toContain("CapabilityBoundingSet=\n");
    expect(() =>
      updaterInstaller(
        "https://panel.example.com",
        { x86_64: "a".repeat(64) },
        publicKey,
      ),
    ).toThrow();
    for (const script of [
      installer(
        "https://panel.example.com",
        { x86_64: "a".repeat(64), updaterProtocol: 1 },
        publicKey,
      ),
      updaterInstaller(
        "https://panel.example.com",
        { x86_64: "a".repeat(64), updaterProtocol: 1 },
        publicKey,
      ),
    ]) {
      expect(script).toContain(
        `configure-updater '${publicKey}' 'https://panel.example.com'`,
      );
      expect(script).toContain(
        "ExecStart=/usr/local/libexec/tenet-updater update-worker",
      );
      expect(script).toContain("sha256sum --check --status");
      expect(script).not.toContain("--insecure");
      const child = Bun.spawn(["sh", "-n"], { stdin: "pipe", stderr: "pipe" });
      child.stdin.write(script);
      child.stdin.end();
      expect(await child.exited).toBe(0);
    }
  });
});
