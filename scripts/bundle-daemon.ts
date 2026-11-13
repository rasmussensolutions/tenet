import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Run before dashboard build so Vite copies the release into static assets for all hosts.
const directory = resolve("apps/dashboard/public/daemon");
await mkdir(directory, { recursive: true });
const arches = process.argv.slice(2);
if (!arches.length) arches.push("x86_64", "aarch64");
if (arches.some((arch) => !["x86_64", "aarch64"].includes(arch)))
  throw new Error("Usage: bun run bundle:daemon [x86_64] [aarch64]");
async function run(args: string[]) {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error(`Failed: ${args[0]}`);
}
const version = (await readFile("Cargo.toml", "utf8")).match(
  /^version = "([^"\n]+)"/m,
)?.[1];
// Hash the exact build inputs, including dirty local source, rather than claiming a git commit.
const inputPaths = [
  "Cargo.toml",
  "Cargo.lock",
  "deploy/daemon/Dockerfile",
  ...Array.from(
    new Bun.Glob("**/*").scanSync({ cwd: "apps/daemon", onlyFiles: true }),
  ).map((path) => `apps/daemon/${path}`),
].sort();
const hash = createHash("sha256");
for (const path of inputPaths) {
  hash.update(path);
  hash.update("\0");
  hash.update(await readFile(path));
  hash.update("\0");
}
const buildId = hash.digest("hex");
let manifest: Record<string, string | number> = {};
try {
  manifest = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf8"),
  );
} catch {
  /* First build. */
}
// Never accidentally combine architectures from different source revisions.
if (manifest.buildId !== buildId) manifest = {};
manifest.version = version ?? "invalid";
manifest.buildId = buildId;
manifest.updaterProtocol = 1;
for (const arch of arches) {
  const platform = arch === "x86_64" ? "linux/amd64" : "linux/arm64";
  const output = resolve("target", `daemon-${arch}`);
  await run([
    "docker",
    "buildx",
    "build",
    "--platform",
    platform,
    "--build-arg",
    `TENET_BUILD_ID=${buildId}`,
    "--file",
    "deploy/daemon/Dockerfile",
    "--output",
    `type=local,dest=${output}`,
    ".",
  ]);
  const bytes = await readFile(resolve(output, "tenetd"));
  const destination = resolve(directory, `tenetd-linux-${arch}`);
  await writeFile(`${destination}.tmp`, bytes, { mode: 0o755 });
  await rename(`${destination}.tmp`, destination);
  manifest[arch] = createHash("sha256").update(bytes).digest("hex");
}
await writeFile(
  resolve(directory, "manifest.json.tmp"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await rename(
  resolve(directory, "manifest.json.tmp"),
  resolve(directory, "manifest.json"),
);
console.info(
  "Daemon binaries and pinned checksums bundled. Build/redeploy your dashboard to publish them.",
);
