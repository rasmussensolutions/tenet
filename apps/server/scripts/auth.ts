import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStore, type Sql } from "@tenet/api";
import pg from "pg";

// Deployment-only administration. There is intentionally no HTTP equivalent.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const command = process.argv[2];
const worker = process.argv.includes("--worker");
const remote = process.argv.includes("--remote");
if (!["migrate", "setup", "recover", "cleanup"].includes(command ?? ""))
  throw new Error(
    "Usage: bun run auth:admin <migrate|setup|recover|cleanup> [--worker [--remote]]",
  );
if (remote && !worker) throw new Error("--remote is only for D1.");
const pool = worker
  ? undefined
  : new pg.Pool({ connectionString: process.env.DATABASE_URL });
if (!worker && !process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required.");
async function wrangler(args: string[]) {
  const child = Bun.spawn(
    ["bun", "run", "--filter", "@tenet/worker", "exec:wrangler", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status) throw new Error(`Wrangler failed: ${err}`);
  // bun --filter prefixes output; strip its package label before parsing Wrangler JSON.
  return out
    .split("\n")
    .map((line) => line.replace(/^@tenet\/worker exec:wrangler: ?/, ""))
    .filter((line) => !line.startsWith("Exited with code"))
    .join("\n");
}
const sql: Sql = {
  async query<T extends Record<string, unknown>>(
    query: string,
    values: unknown[] = [],
  ) {
    if (pool) return (await pool.query<T>(query, values)).rows;
    const statement = query.replace(/\$(\d+)/g, (_, index: string) => {
      const value = values[Number(index) - 1];
      return value === null
        ? "NULL"
        : typeof value === "number"
          ? String(value)
          : `'${String(value).replaceAll("'", "''")}'`;
    });
    const dir = await mkdtemp(join(tmpdir(), "tenet-admin-"));
    try {
      const file = join(dir, "query.sql");
      await writeFile(file, statement, { mode: 0o600 });
      const result = JSON.parse(
        await wrangler([
          "d1",
          "execute",
          "tenet",
          remote ? "--remote" : "--local",
          "--file",
          file,
          "--json",
        ]),
      ) as { results: T[] }[];
      return result.flatMap((r) => r.results);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
};
try {
  if (command === "migrate") {
    if (worker)
      console.info(
        await wrangler([
          "d1",
          "migrations",
          "apply",
          "tenet",
          remote ? "--remote" : "--local",
        ]),
      );
    else if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(76381025)");
        await client.query(
          "CREATE TABLE IF NOT EXISTS tenet_migrations (name TEXT PRIMARY KEY)",
        );
        const directory = join(root, "packages/api/migrations/postgres");
        for (const name of (await readdir(directory))
          .filter((s) => s.endsWith(".sql"))
          .sort()) {
          if (
            (
              await client.query(
                "SELECT name FROM tenet_migrations WHERE name = $1",
                [name],
              )
            ).rowCount
          )
            continue;
          await client.query(await readFile(join(directory, name), "utf8"));
          await client.query("INSERT INTO tenet_migrations VALUES ($1)", [
            name,
          ]);
          console.info(`Applied ${name}`);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
  } else {
    const store = new AuthStore(sql);
    if (command === "setup")
      console.info(
        `One-use setup code (expires in 30 minutes):\n${await store.issueSetup()}`,
      );
    if (command === "recover")
      console.info(
        `One-use recovery code (replaces existing recovery codes):\n${await store.issueRecovery()}`,
      );
    if (command === "cleanup") {
      await sql.query("DELETE FROM tenet_auth_rate WHERE reset_at < $1", [
        Date.now(),
      ]);
      await sql.query("DELETE FROM tenet_auth_audit WHERE occurred_at < $1", [
        Date.now() - 90 * 86400_000,
      ]);
      // Better Auth adapters encode their date columns differently.
      await sql.query('DELETE FROM session WHERE "expiresAt" < $1', [
        worker ? Date.now() : new Date().toISOString(),
      ]);
      await sql.query('DELETE FROM verification WHERE "expiresAt" < $1', [
        worker ? Date.now() : new Date().toISOString(),
      ]);
      console.info(
        "Expired authentication data cleaned up; audit retention is 90 days.",
      );
    }
  }
} finally {
  await pool?.end();
}
