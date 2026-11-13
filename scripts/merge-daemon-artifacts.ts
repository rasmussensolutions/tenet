import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: bun scripts/merge-daemon-artifacts.ts <input-directory> <output-directory>",
  );
await mkdir(output, { recursive: true });
let merged: Record<string, string | number> | undefined;
for (const arch of ["x86_64", "aarch64"]) {
  const directory = resolve(input, `daemon-${arch}`);
  const manifest = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf8"),
  );
  if (!merged)
    merged = {
      version: manifest.version,
      buildId: manifest.buildId,
      updaterProtocol: manifest.updaterProtocol,
    };
  if (
    merged.version !== manifest.version ||
    merged.buildId !== manifest.buildId ||
    merged.updaterProtocol !== manifest.updaterProtocol
  )
    throw new Error(
      "Architecture builds must come from identical source inputs.",
    );
  const name = `tenetd-linux-${arch}`;
  const bytes = await readFile(resolve(directory, name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== manifest[arch])
    throw new Error(`Invalid artifact checksum: ${arch}`);
  merged[arch] = digest;
  await copyFile(resolve(directory, name), resolve(output, name));
}
await writeFile(
  resolve(output, "manifest.json"),
  `${JSON.stringify(merged, null, 2)}\n`,
  { flag: "wx" },
);
