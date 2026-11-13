import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const html = await readFile("dist/client/index.html", "utf8");
const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
  .filter((match) => match[1])
  .map(
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
  );
const headers = {
  "Content-Security-Policy": `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Cache-Control": "no-store",
};
await writeFile(
  "dist/client/_headers",
  `/*\n${Object.entries(headers)
    .map(([name, value]) => `  ${name}: ${value}`)
    .join("\n")}\n`,
);
await writeFile("dist/client/security-headers.json", JSON.stringify(headers));
