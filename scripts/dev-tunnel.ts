import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
async function run(args: string[], env = process.env) {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  if (await child.exited)
    throw new Error(`${args.slice(0, 3).join(" ")} failed.`);
}
try {
  if (!Bun.which("cloudflared"))
    throw new Error("Install cloudflared first: brew install cloudflared");
  if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET)
    throw new Error(
      "Configure DATABASE_URL and BETTER_AUTH_SECRET in apps/server/.env first.",
    );
  // Only start the existing local dev container; never provision or reset a database.
  const database = new URL(process.env.DATABASE_URL);
  if (
    ["localhost", "127.0.0.1"].includes(database.hostname) &&
    Bun.which("docker")
  ) {
    const check = Bun.spawn(
      ["docker", "inspect", "--format", "{{.State.Running}}", "tenet-dev-db"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const state = (await new Response(check.stdout).text()).trim();
    if ((await check.exited) === 0 && state === "false")
      await run(["docker", "start", "tenet-dev-db"]);
  }
  if (["localhost", "127.0.0.1"].includes(database.hostname)) {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const socket = await Bun.connect({
          hostname: database.hostname,
          port: Number(database.port || 5432),
          socket: {
            data() {},
            open(socket) {
              socket.end();
            },
            error() {},
          },
        });
        socket.end();
        ready = true;
        break;
      } catch {
        await Bun.sleep(1000);
      }
    }
    if (!ready)
      throw new Error(
        "Local PostgreSQL is unavailable. Start Docker Desktop and retry.",
      );
  }
  await run(["bun", "run", "auth:admin", "migrate"]);
  const address = process.env.TENET_ORIGIN ?? "";
  if (!address.startsWith("https://") || new URL(address).origin !== address)
    throw new Error(
      "Set TENET_ORIGIN to your fixed HTTPS development origin in apps/server/.env.",
    );
  const config = resolve(root, "deploy/cloudflare/dev-tunnel.yml");
  const env = {
    ...process.env,
    TENET_ORIGIN: address,
    HOST: "127.0.0.1",
    PORT: "3002",
    TENET_ASSETS_DIR: "",
    TENET_DEV_ORIGIN: address,
  };
  const server = Bun.spawn(["bun", "--watch", "apps/server/src/index.ts"], {
    cwd: root,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(server);
  const vite = Bun.spawn(
    ["bun", "run", "--filter", "@tenet/dashboard", "dev"],
    {
      cwd: root,
      env,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  children.push(vite);
  const tunnel = Bun.spawn(
    ["cloudflared", "tunnel", "--config", config, "run"],
    {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  children.push(tunnel);
  console.info(
    `\nOpen ${address}\nUI updates on save. API restarts automatically. Ctrl+C stops development.\n`,
  );
  await Promise.race([server.exited, vite.exited, tunnel.exited]);
  if (!stopping)
    throw new Error(
      "A development process stopped. Check the output above and ensure ports 3000 and 3002 are free.",
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Development startup failed.",
  );
  stop(1);
}
