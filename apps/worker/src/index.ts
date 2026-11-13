import { createApi, type Sql } from "@tenet/api";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/health")
      return env.ASSETS.fetch(request);
    const sql: Sql = {
      async query<T extends Record<string, unknown>>(
        query: string,
        values: unknown[] = [],
      ) {
        const ordered: unknown[] = [];
        const statement = query.replace(/\$(\d+)/g, (_, index: string) => {
          ordered.push(values[Number(index) - 1]);
          return "?";
        });
        return (
          await env.DB.prepare(statement)
            .bind(...ordered)
            .all<T>()
        ).results;
      },
    };
    // Never retain D1 bindings or request state in global scope.
    return createApi(
      {
        origin: env.TENET_ORIGIN,
        secret: env.BETTER_AUTH_SECRET,
        database: env.DB,
        sql,
        releaseUrl: env.TENET_RELEASE_URL,
        releasePublicKey: env.TENET_RELEASE_PUBLIC_KEY,
        loadDaemonRelease: async () => {
          const response = await env.ASSETS.fetch(
            new Request(`${env.TENET_ORIGIN}/daemon/manifest.json`),
          );
          if (!response.ok) throw new Error("Daemon release is unavailable");
          return response.json();
        },
      },
      (req) => req.headers.get("cf-connecting-ip") ?? "shared",
    ).fetch(request);
  },
} satisfies ExportedHandler<Env>;
