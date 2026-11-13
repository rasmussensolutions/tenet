import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src";
import { hash, randomToken } from "../src/auth/store";
import {
  installCommand,
  installer,
  releaseManifest,
} from "../src/machines/installer";
import { MachineStore } from "../src/machines/store";
import { Browser, enrolled, fixture, timestamp } from "./helpers";

const sample = {
  version: 1 as const,
  hostname: "test-vps",
  os: "Ubuntu 24.04",
  arch: "x86_64",
  agentVersion: "0.0.0",
  cpuCount: 2,
  cpuPercent: 24.5,
  memoryTotal: 4_000_000_000,
  memoryUsed: 1_000_000_000,
  uptime: 60,
  disks: [{ mount: "/", total: 80_000_000_000, used: 20_000_000_000 }],
};
function agent(
  app: ReturnType<typeof createApi>,
  path: string,
  token: string,
  body: unknown,
) {
  return app.request(`/api/agent/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}
async function machine() {
  const f = await fixture();
  const machines = new MachineStore(f.sql);
  const ticket = await machines.create("Production");
  const credential = randomToken();
  return { ...f, machines, ticket, credential };
}

describe("machine enrollment and telemetry", () => {
  test("atomically claims one machine, retries lost responses, and never exposes credential hashes", async () => {
    const f = await machine();
    const other = randomToken();
    const responses = await Promise.all([
      agent(f.app, "enroll", f.ticket.token, { credential: f.credential }),
      agent(f.app, "enroll", f.ticket.token, { credential: other }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    const winning = responses[0]?.status === 200 ? f.credential : other;
    expect(
      (await agent(f.app, "enroll", f.ticket.token, { credential: winning }))
        .status,
    ).toBe(200);
    expect(
      (
        await agent(f.app, "enroll", f.ticket.token, {
          credential: randomToken(),
        })
      ).status,
    ).toBe(401);
    const rows = await f.sql.query("SELECT * FROM tenet_machine");
    expect(JSON.stringify(rows)).not.toContain(winning);
    expect(JSON.stringify(rows)).not.toContain(f.ticket.token);
    expect((await f.machines.list())[0]?.status).toBe("connecting");
    const payload = JSON.stringify(await f.machines.list());
    expect(payload).not.toContain(await hash(winning));
    expect(payload).not.toContain(await hash(f.ticket.token));
  });
  test("expired and cancelled enrollment commands cannot connect", async () => {
    const f = await machine();
    await f.sql.query("UPDATE tenet_machine SET enrollment_expires = $1", [
      Date.now() - 1,
    ]);
    expect(
      (
        await agent(f.app, "enroll", f.ticket.token, {
          credential: f.credential,
        })
      ).status,
    ).toBe(401);
    expect((await f.machines.list())[0]?.status).toBe("expired");
    const next = await f.machines.create("Cancelled");
    await f.machines.revoke(next.id);
    expect(
      (await agent(f.app, "enroll", next.token, { credential: f.credential }))
        .status,
    ).toBe(401);
  });
  test("credentials only update their own metrics; revocation blocks new and in-flight writes", async () => {
    const f = await machine();
    await f.machines.enroll(f.ticket.token, f.credential);
    const other = await f.machines.create("Other machine");
    await f.machines.enroll(other.token, randomToken());
    expect(
      (await agent(f.app, "telemetry", f.ticket.token, sample)).status,
    ).toBe(401);
    expect(
      (
        await agent(f.app, "telemetry", f.credential, {
          ...sample,
          id: other.id,
        })
      ).status,
    ).toBe(200);
    const rows = await f.machines.list();
    expect(rows.find((m) => m.id === f.ticket.id)?.telemetry).toEqual(sample);
    expect(rows.find((m) => m.id === other.id)?.telemetry).toBeNull();
    expect(rows.find((m) => m.id === f.ticket.id)?.status).toBe("online");
    await f.sql.query("UPDATE tenet_machine SET last_seen = $1 WHERE id = $2", [
      Date.now() - 61_000,
      f.ticket.id,
    ]);
    expect(
      (await f.machines.list()).find((m) => m.id === f.ticket.id)?.status,
    ).toBe("offline");
    const id = await f.machines.identity(f.credential);
    await f.machines.revoke(id);
    expect((await agent(f.app, "telemetry", f.credential, sample)).status).toBe(
      401,
    );
    await expect(
      f.machines.ingest(id, { ...sample, version: 1 }),
    ).rejects.toThrow("INVALID_MACHINE_CREDENTIAL");
    expect(
      (
        await agent(f.app, "enroll", f.ticket.token, {
          credential: f.credential,
        })
      ).status,
    ).toBe(401);
  });
  test("rejects malformed, oversized, impossible and cross-origin reports", async () => {
    const f = await machine();
    await f.machines.enroll(f.ticket.token, f.credential);
    for (const body of [
      null,
      [],
      {},
      { ...sample, version: 2 },
      { ...sample, cpuPercent: 101 },
      { ...sample, memoryUsed: sample.memoryTotal + 1 },
      { ...sample, disks: Array(33).fill(sample.disks[0]) },
      { ...sample, hostname: "bad\nname" },
    ])
      expect((await agent(f.app, "telemetry", f.credential, body)).status).toBe(
        400,
      );
    expect(
      (
        await agent(f.app, "telemetry", f.credential, {
          ...sample,
          hostname: "x".repeat(33_000),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await f.app.request("/api/agent/telemetry", {
          method: "POST",
          headers: {
            origin: "https://evil.test",
            "content-type": "application/json",
            authorization: `Bearer ${f.credential}`,
          },
          body: JSON.stringify(sample),
        })
      ).status,
    ).toBe(403);
    expect((await f.machines.list())[0]?.lastSeen).toBeNull();
  });
  test("enforces per-machine limits without consuming browser or other machine budgets", async () => {
    const f = await machine();
    await f.machines.enroll(f.ticket.token, f.credential);
    for (let index = 0; index < 12; index++)
      expect(
        (await agent(f.app, "telemetry", f.credential, sample)).status,
      ).toBe(200);
    expect((await agent(f.app, "telemetry", f.credential, sample)).status).toBe(
      429,
    );
    const second = await f.machines.create("Second");
    const credential = randomToken();
    await f.machines.enroll(second.token, credential);
    expect((await agent(f.app, "telemetry", credential, sample)).status).toBe(
      200,
    );
    expect((await new Browser(f.app).request("/setup/status")).status).toBe(
      200,
    );
  });
  test("browser authentication cannot substitute for a machine credential", async () => {
    const f = await enrolled();
    expect((await f.browser.request("/agent/telemetry", sample)).status).toBe(
      401,
    );
    expect((await new Browser(f.app).request("/machines")).status).toBe(401);
    expect(
      (
        await new Browser(f.app).request("/machines/enrollments", {
          name: "Unauthorized",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.app.request("/api/machines", {
          headers: { authorization: `Bearer ${randomToken()}` },
        })
      ).status,
    ).toBe(401);
    expect((await f.browser.request("/machines")).status).toBe(200);
    expect(
      (await f.browser.request("/machines/enrollments", { name: "Local" }))
        .status,
    ).toBe(409);
  });
  test("owner can issue and revoke with fresh auth; all mutations retain CSRF protection", async () => {
    const f = await enrolled();
    // The same DB-backed signed session over the production host-only cookie boundary.
    const origin = "https://localhost:3100";
    const secure = createApi({
      ...f.env,
      origin,
      loadDaemonRelease: async () => ({ x86_64: "a".repeat(64) }),
    });
    const browser = new Browser(secure);
    for (const [key, value] of f.browser.cookies)
      browser.cookies.set(key.replace(/^tenet\./, "__Host-tenet."), value);
    const request = (path: string, body?: unknown) =>
      browser.request(path, body, { origin });
    const issued = await request("/machines/enrollments", {
      name: "Production",
    });
    expect(issued.status).toBe(200);
    const { id, command } = await issued.json();
    expect(command).toContain("https://localhost:3100/api/agent/install.sh");
    expect(
      (
        await secure.request("/api/machines/revoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        })
      ).status,
    ).toBe(403);
    await f.sql.query('UPDATE session SET "createdAt" = $1', [
      timestamp(Date.now() - 360_000),
    ]);
    expect(
      (await request("/machines/enrollments", { name: "Stale" })).status,
    ).toBe(403);
    expect((await request("/machines/revoke", { id })).status).toBe(403);
    await f.sql.query('UPDATE session SET "createdAt" = $1', [
      timestamp(Date.now()),
    ]);
    expect((await request("/machines/revoke", { id })).status).toBe(200);
    expect((await (await request("/machines")).json()).machines[0].status).toBe(
      "revoked",
    );
    const events = await f.sql.query<{ event: string }>(
      "SELECT event FROM tenet_auth_audit WHERE subject = $1",
      [id],
    );
    expect(events.map((row) => row.event).sort()).toEqual([
      "machine.enrollment_issued",
      "machine.revoked",
    ]);
  });
  test("generated install command pipes exactly one token line through sudo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenet-installer-test-"));
    const token = randomToken();
    try {
      // Stub downloads and privilege elevation; exercise the actual generated shell command.
      await writeFile(
        join(directory, "curl"),
        `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then shift; destination="$1"; fi
  shift
done
cat > "$destination" <<'SCRIPT'
#!/bin/sh
set -eu
IFS= read -r token
[ "$token" = '${token}' ]
printf success
SCRIPT
`,
        { mode: 0o755 },
      );
      await writeFile(
        join(directory, "sudo"),
        '#!/bin/sh\n[ "$1" = -v ] && exit 0\nexec "$@"\n',
        { mode: 0o755 },
      );
      await writeFile(join(directory, "id"), "#!/bin/sh\necho 1000\n", {
        mode: 0o755,
      });
      const child = Bun.spawn(
        ["sh", "-c", installCommand("https://panel.example.com", token)],
        {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toBe("success");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("installer fails closed without artifacts and pins artifact integrity", async () => {
    const f = await fixture();
    expect((await f.app.request("/api/agent/install.sh")).status).toBe(503);
    expect(() => releaseManifest({ x86_64: "injected; command" })).toThrow();
    expect(() =>
      installer("http://localhost:3000", { x86_64: "a".repeat(64) }),
    ).toThrow();
    const script = installer("https://panel.example.com", {
      x86_64: "a".repeat(64),
    });
    expect(script).toContain("sha256sum --check --status");
    expect(script).toContain("User=tenetd");
    expect(script).toContain("NoNewPrivileges=true");
    expect(script).not.toContain("--insecure");
    const check = Bun.spawn(["sh", "-n"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    check.stdin.write(script);
    check.stdin.end();
    expect(await check.exited).toBe(0);
    const command = installCommand("https://panel.example.com", "a".repeat(64));
    expect(command).not.toContain("--token");
    expect(command).toContain("sudo -v");
  });
});

const binary = process.env.TENET_DAEMON_TEST_BINARY;
test.skipIf(!binary)(
  "real daemon enrolls, persists identity, reports host metrics, and stops after revocation",
  async () => {
    const f = await machine();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: f.app.fetch,
    });
    const directory = await mkdtemp(join(tmpdir(), "tenet-daemon-e2e-"));
    await chmod(directory, 0o700);
    const path = join(directory, "identity.json");
    async function run(args: string[], input?: string) {
      const child = Bun.spawn([binary as string, ...args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      if (input) child.stdin.write(input);
      child.stdin.end();
      const [status, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(output + error).not.toContain(f.ticket.token);
      return { status, output, error };
    }
    try {
      const result = await run(
        [
          "enroll",
          "--panel",
          `http://localhost:${server.port}`,
          "--config",
          path,
        ],
        `${f.ticket.token}\n`,
      );
      expect(result).toMatchObject({ status: 0 });
      const identity = JSON.parse(await readFile(path, "utf8"));
      expect(identity.machineId).toBe(f.ticket.id);
      expect(result.output + result.error).not.toContain(identity.credential);
      expect((await run(["run", "--config", path, "--once"])).status).toBe(0);
      const [machine] = await f.machines.list();
      expect(machine?.status).toBe("online");
      expect(machine?.telemetry?.cpuCount).toBeGreaterThan(0);
      expect(machine?.telemetry?.memoryTotal).toBeGreaterThan(0);
      expect(machine?.telemetry?.disks.length).toBeGreaterThan(0);
      await f.machines.revoke(f.ticket.id);
      expect((await run(["run", "--config", path, "--once"])).status).toBe(77);
    } finally {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
