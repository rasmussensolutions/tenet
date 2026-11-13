import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApi } from "../src";
import { randomToken } from "../src/auth/store";
import { Releases } from "../src/machines/releases";
import { MachineStore } from "../src/machines/store";
import { Updates } from "../src/machines/updates";
import { Browser, enrolled } from "./helpers";

// Runs the production Linux executable against the real API and database over verified
// HTTPS. Only systemctl is replaced: its restart launches the real daemon as tenetd.
// No root operations touch the host; the container has no host mounts except fixtures.
test.skipIf(!process.env.TENET_TEST_LINUX_UPDATER)(
  "Linux updater: install, receipt retry, tamper rejection, rollback and crash recovery",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenet-update-e2e-"));
    const container = `tenet-updater-test-${randomToken().slice(0, 12)}`;
    async function command(args: string[]) {
      const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code)
        throw new Error(
          `Test command ${args[0]} failed: ${stderr.slice(0, 2000)}`,
        );
      return stdout;
    }
    const exec = (...args: string[]) =>
      command(["docker", "exec", container, ...args]);
    const f = await enrolled();
    const machines = new MachineStore(f.sql);
    const ticket = await machines.create("Linux updater fixture");
    const credential = randomToken();
    await machines.enroll(ticket.token, credential);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = Buffer.from(
      keys.publicKey.export({ format: "jwk" }).x ?? "",
      "base64url",
    ).toString("hex");
    const binary = await readFile(
      resolve("apps/dashboard/public/daemon/tenetd-linux-x86_64"),
    );
    const bundled = JSON.parse(
      await readFile(
        resolve("apps/dashboard/public/daemon/manifest.json"),
        "utf8",
      ),
    );
    const old = Buffer.from(
      '#!/bin/sh\nif [ "$1" = --version ]; then echo "tenetd 0.0.0"; exit 0; fi\nexec sleep infinity\n',
    );
    let artifact: Uint8Array = binary;
    let denyReceipt = false;
    let artifactHadCredential = false;
    let app: ReturnType<typeof createApi>;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await writeFile(
        join(directory, "ca.cnf"),
        "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Tenet integration CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n",
      );
      await writeFile(
        join(directory, "leaf.cnf"),
        "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=host.docker.internal\n[ext]\nsubjectAltName=DNS:host.docker.internal\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
      );
      await command([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-keyout",
        join(directory, "ca-key.pem"),
        "-out",
        join(directory, "ca.pem"),
        "-config",
        join(directory, "ca.cnf"),
      ]);
      await command([
        "openssl",
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "leaf.csr"),
        "-config",
        join(directory, "leaf.cnf"),
      ]);
      await command([
        "openssl",
        "x509",
        "-req",
        "-in",
        join(directory, "leaf.csr"),
        "-CA",
        join(directory, "ca.pem"),
        "-CAkey",
        join(directory, "ca-key.pem"),
        "-CAcreateserial",
        "-days",
        "1",
        "-extfile",
        join(directory, "leaf.cnf"),
        "-extensions",
        "ext",
        "-out",
        join(directory, "cert.pem"),
      ]);
      server = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        tls: {
          key: Bun.file(join(directory, "key.pem")),
          cert: Bun.file(join(directory, "cert.pem")),
        },
        fetch: async (req) => {
          if (
            ["/artifact", "/daemon/tenetd-linux-x86_64"].includes(
              new URL(req.url).pathname,
            )
          ) {
            artifactHadCredential ||= req.headers.has("authorization");
            return new Response(new Uint8Array(artifact));
          }
          if (denyReceipt && new URL(req.url).pathname.endsWith("/report")) {
            const body = await req.clone().json();
            if (body.status === "succeeded")
              return new Response("lost", { status: 503 });
          }
          return app.fetch(req);
        },
      });
      const panel = `https://host.docker.internal:${server.port}`;
      const env = {
        ...f.env,
        origin: panel,
        releaseUrl: `${panel}/release.json`,
        releasePublicKey: publicKey,
        loadDaemonRelease: async () => bundled,
      };
      app = createApi(env);
      const browser = new Browser(app);
      for (const [key, value] of f.browser.cookies)
        browser.cookies.set(key.replace(/^tenet\./, "__Host-tenet."), value);
      const updates = new Updates(
        f.sql,
        new Releases(f.sql, env.releaseUrl, publicKey),
      );
      async function release(version: string, bytes: Uint8Array) {
        artifact = bytes;
        const manifest = JSON.stringify({
          schema: 1,
          version,
          buildId: bundled.buildId,
          protocol: 1,
          updaterProtocol: 1,
          channel: "stable",
          expiresAt: Date.now() + 3600000,
          artifacts: {
            x86_64: {
              url: `${panel}/artifact`,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              size: bytes.length,
            },
          },
        });
        const envelope = {
          manifest,
          signature: sign(
            null,
            Buffer.from(manifest),
            keys.privateKey,
          ).toString("hex"),
        };
        await f.sql.query(
          "UPDATE tenet_release SET envelope=$1, checked_at=$2, next_check=$3 WHERE id=1",
          [JSON.stringify(envelope), Date.now(), Date.now() + 900000],
        );
      }
      await writeFile(
        join(directory, "identity.json"),
        JSON.stringify({ panel, credential, machineId: ticket.id }),
        { mode: 0o600 },
      );
      await writeFile(join(directory, "tenetd"), binary, { mode: 0o755 });
      await writeFile(join(directory, "old"), old, { mode: 0o755 });
      await writeFile(
        join(directory, "systemctl"),
        `#!/bin/sh
set -eu
case "$1" in show-environment|daemon-reload|enable|start) exit 0 ;; esac
[ "$1" = restart ] && [ "$2" = tenetd.service ]
if [ -f /run/tenetd.pid ]; then kill "$(cat /run/tenetd.pid)" 2>/dev/null || true; fi
rm -f /run/tenetd.pid
start-stop-daemon --start --background --make-pidfile --pidfile /run/tenetd.pid --chuid tenetd --startas /usr/local/bin/tenetd -- run --config /var/lib/tenetd/identity.json
`,
        { mode: 0o755 },
      );
      await command([
        "docker",
        "run",
        "-d",
        "--name",
        container,
        "--platform",
        "linux/amd64",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--mount",
        `type=bind,source=${directory},target=/fixtures,readonly`,
        "tenet-updater-test",
      ]);
      await exec(
        "sh",
        "-ec",
        `useradd --system tenetd
install -d -m 0700 -o tenetd /var/lib/tenetd
install -m 0600 -o tenetd /fixtures/identity.json /var/lib/tenetd/identity.json
install -m 0755 /fixtures/old /usr/local/bin/tenetd
mkdir -p /etc/systemd/system
touch /etc/systemd/system/tenetd.service
install -m 0755 /fixtures/systemctl /usr/bin/systemctl
cp /fixtures/ca.pem /usr/local/share/ca-certificates/tenet-test.crt
update-ca-certificates >/dev/null`,
      );
      await exec(
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        `${panel}/api/agent/updater.sh`,
        "-o",
        "/tmp/updater.sh",
      );
      await exec("sh", "/tmp/updater.sh");
      expect(
        (await exec("stat", "-c", "%a", "/etc/tenet/updater.json")).trim(),
      ).toBe("600");
      // Honor the restrictive production service umask during every update.
      const tick = () =>
        exec(
          "sh",
          "-ec",
          "umask 077; /usr/local/libexec/tenet-updater update-worker",
        );
      await tick();
      await machines.ingest(ticket.id, {
        version: 1,
        hostname: "fixture",
        os: "Linux",
        arch: "x86_64",
        agentVersion: "0.0.0",
        cpuCount: 1,
        cpuPercent: 0,
        memoryTotal: 1024,
        memoryUsed: 1,
        uptime: 0,
        disks: [],
      });
      await release(bundled.version, binary);
      const request = await browser.request(
        "/machines/updates",
        { id: ticket.id },
        { origin: panel },
      );
      expect(request.status).toBe(200);
      denyReceipt = true;
      await expect(tick()).rejects.toThrow();
      expect(await exec("cat", "/var/lib/tenet-updater/version")).toBe(
        bundled.version,
      );
      expect(
        (await exec("stat", "-c", "%a", "/usr/local/bin/tenetd")).trim(),
      ).toBe("755");
      expect((await machines.list())[0]?.telemetry?.agentBuildId).toBe(
        bundled.buildId,
      );
      denyReceipt = false;
      await tick();
      expect((await updates.list())[0]?.status).toBe("succeeded");
      expect(artifactHadCredential).toBe(false);
      // A valid signature over a different digest must not install modified downloads.
      await release("0.2.0", binary);
      artifact = Buffer.from("tampered");
      await updates.queue(ticket.id);
      await tick();
      expect((await updates.list())[0]?.status).toBe("failed");
      expect(
        (await exec("sha256sum", "/usr/local/bin/tenetd")).split(" ")[0],
      ).toBe(createHash("sha256").update(binary).digest("hex"));
      // A correctly signed executable that crashes must automatically restore the old daemon.
      const broken = Buffer.from("#!/bin/sh\nexit 1\n");
      await release("0.2.0", broken);
      await updates.queue(ticket.id);
      await tick();
      expect((await updates.list())[0]?.status).toBe("rolled_back");
      expect(await exec("cat", "/var/lib/tenet-updater/version")).toBe(
        bundled.version,
      );
      expect(
        (await exec("sha256sum", "/usr/local/bin/tenetd")).split(" ")[0],
      ).toBe(createHash("sha256").update(binary).digest("hex"));
      // Simulate a crash after replacing the binary but before acknowledging health.
      const journal = JSON.parse(
        await exec("cat", "/var/lib/tenet-updater/journal.json"),
      );
      journal.status = "installing";
      await writeFile(
        join(directory, "crash-journal.json"),
        JSON.stringify(journal),
      );
      await exec(
        "sh",
        "-ec",
        "install -m 0600 /fixtures/crash-journal.json /var/lib/tenet-updater/journal.json; printf '#!/bin/sh\\nexit 1\\n' > /usr/local/bin/crashed; chmod 0755 /usr/local/bin/crashed; mv /usr/local/bin/crashed /usr/local/bin/tenetd",
      );
      await tick();
      expect(
        (await exec("sha256sum", "/usr/local/bin/tenetd")).split(" ")[0],
      ).toBe(createHash("sha256").update(binary).digest("hex"));
      expect(
        JSON.parse(await exec("cat", "/var/lib/tenet-updater/journal.json"))
          .status,
      ).toBe("rolled_back");
    } finally {
      await command(["docker", "rm", "-f", container]).catch(() => {});
      server?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  240000,
);
