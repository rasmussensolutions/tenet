import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyRelease } from "../packages/api/src/machines/releases";

const [command, ...args] = process.argv.slice(2);
if (command === "keygen") {
  if (args.length !== 1)
    throw new Error("Usage: bun run release:daemon keygen <private-directory>");
  const directory = resolve(args[0] ?? "");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(
    publicKey.export({ format: "jwk" }).x ?? "",
    "base64url",
  ).toString("hex");
  await writeFile(
    resolve(directory, "private.pem"),
    privateKey.export({ format: "pem", type: "pkcs8" }),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(resolve(directory, "public-key.txt"), `${raw}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  console.info(
    `Signing key saved privately to ${directory}/private.pem. Keep it out of the repository and panel.\nPublic key: ${raw}`,
  );
} else if (command === "sign") {
  if (args.length !== 3)
    throw new Error(
      "Usage: TENET_RELEASE_SIGNING_KEY_FILE=... bun run release:daemon sign <bundled-directory> <versioned-HTTPS-base-url> <output-file>",
    );
  const [directory, base, output] = args as [string, string, string];
  const url = new URL(base.endsWith("/") ? base : `${base}/`);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.includes("/latest/")
  )
    throw new Error("Use an immutable, version-specific HTTPS asset URL.");
  const input = JSON.parse(
    await readFile(resolve(directory, "manifest.json"), "utf8"),
  );
  if (
    process.env.RELEASE_TAG &&
    process.env.RELEASE_TAG !== `daemon-v${input.version}`
  )
    throw new Error("Release tag must match Cargo.toml version.");
  const pem = process.env.TENET_RELEASE_SIGNING_KEY_FILE
    ? await readFile(process.env.TENET_RELEASE_SIGNING_KEY_FILE, "utf8")
    : process.env.TENET_RELEASE_SIGNING_KEY;
  if (!pem)
    throw new Error("A release signing key file or CI secret is required.");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Use an Ed25519 signing key.");
  const artifacts: Record<
    string,
    { url: string; sha256: string; size: number }
  > = {};
  for (const arch of ["x86_64", "aarch64"]) {
    if (!input[arch]) continue;
    const name = `tenetd-linux-${arch}`;
    const bytes = await readFile(resolve(directory, name));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== input[arch])
      throw new Error(`Bundled checksum mismatch: ${arch}`);
    artifacts[arch] = {
      url: new URL(name, url).href,
      sha256,
      size: bytes.length,
    };
  }
  // Expiry bounds replay of old release metadata. Publish a newer version before expiry.
  const manifest = JSON.stringify({
    schema: 1,
    version: input.version,
    buildId: input.buildId,
    protocol: 1,
    updaterProtocol: input.updaterProtocol,
    channel: "stable",
    expiresAt: Date.now() + 90 * 86400000,
    artifacts,
  });
  const envelope = {
    manifest,
    signature: sign(null, Buffer.from(manifest), key).toString("hex"),
  };
  const publicKey = Buffer.from(
    createPublicKey(key).export({ format: "jwk" }).x ?? "",
    "base64url",
  ).toString("hex");
  await verifyRelease(envelope, publicKey);
  await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`, {
    flag: "wx",
  });
  console.info(`Signed daemon ${input.version}. Public key: ${publicKey}`);
} else {
  throw new Error("Usage: bun run release:daemon <keygen|sign> ...");
}
