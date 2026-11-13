import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRelease } from "../src/machines/releases";

test("release tools combine identical sources, reject mismatches, and sign verified artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tenet-release-tools-"));
  async function run(script: string, args: string[], env = process.env) {
    const child = Bun.spawn(["bun", script, ...args], {
      env,
      stdout: "ignore",
      stderr: "ignore",
    });
    return child.exited;
  }
  const input = join(directory, "input"),
    output = join(directory, "output"),
    keys = join(directory, "keys");
  const bytes = Buffer.from("release fixture");
  const hash = createHash("sha256").update(bytes).digest("hex");
  try {
    for (const arch of ["x86_64", "aarch64"]) {
      const path = join(input, `daemon-${arch}`);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, `tenetd-linux-${arch}`), bytes);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          version: "0.1.1",
          buildId: "a".repeat(64),
          updaterProtocol: 1,
          [arch]: hash,
        }),
      );
    }
    expect(
      await run("scripts/merge-daemon-artifacts.ts", [input, output]),
    ).toBe(0);
    const combined = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    );
    expect(combined.x86_64).toBe(hash);
    expect(combined.aarch64).toBe(hash);
    const badManifest = join(input, "daemon-aarch64", "manifest.json");
    await writeFile(
      badManifest,
      JSON.stringify({ ...combined, buildId: "b".repeat(64) }),
    );
    expect(
      await run("scripts/merge-daemon-artifacts.ts", [
        input,
        join(directory, "mismatched"),
      ]),
    ).not.toBe(0);
    await writeFile(badManifest, JSON.stringify(combined));
    await writeFile(
      join(input, "daemon-aarch64", "tenetd-linux-aarch64"),
      "tampered",
    );
    expect(
      await run("scripts/merge-daemon-artifacts.ts", [
        input,
        join(directory, "tampered"),
      ]),
    ).not.toBe(0);
    expect(await run("scripts/release-daemon.ts", ["keygen", keys])).toBe(0);
    expect(await run("scripts/release-daemon.ts", ["keygen", keys])).not.toBe(
      0,
    );
    const envelopePath = join(directory, "release.json");
    expect(
      await run(
        "scripts/release-daemon.ts",
        ["sign", output, "https://example.com/0.1.1/", envelopePath],
        {
          ...process.env,
          TENET_RELEASE_SIGNING_KEY_FILE: join(keys, "private.pem"),
          RELEASE_TAG: "daemon-v0.1.1",
        },
      ),
    ).toBe(0);
    const key = (await readFile(join(keys, "public-key.txt"), "utf8")).trim();
    expect(
      (
        await verifyRelease(
          JSON.parse(await readFile(envelopePath, "utf8")),
          key,
        )
      ).release.version,
    ).toBe("0.1.1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
