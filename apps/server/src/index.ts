import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApi } from "@tenet/api";
import { daemonDirectory, environment } from "./environment";

const port = Number(process.env.PORT ?? 3002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const { env, pool } = environment();
// Forwarded headers are deliberately ignored. A shared bucket is safe behind a proxy;
// use perimeter limits as well when many administrators share that proxy.
const app = createApi(env);
app.get("/daemon/:file", async (c) => {
  const file = c.req.param("file");
  if (
    !["manifest.json", "tenetd-linux-x86_64", "tenetd-linux-aarch64"].includes(
      file,
    )
  )
    return c.notFound();
  try {
    const bytes = await readFile(join(daemonDirectory, file));
    c.header(
      "Content-Type",
      file.endsWith(".json") ? "application/json" : "application/octet-stream",
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-cache");
    return c.body(bytes);
  } catch {
    return c.notFound();
  }
});
const assets = process.env.TENET_ASSETS_DIR;
if (assets) {
  const headers = JSON.parse(
    await readFile(join(assets, "security-headers.json"), "utf8"),
  ) as Record<string, string>;
  app.use("*", async (c, next) => {
    for (const [name, value] of Object.entries(headers)) c.header(name, value);
    await next();
  });
  app.use("*", serveStatic({ root: assets }));
  app.get("*", serveStatic({ root: assets, path: "index.html" }));
}
const server = serve(
  { fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" },
  (info) => {
    console.info(`Tenet API listening on http://localhost:${info.port}`);
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => void pool.end()));
}
