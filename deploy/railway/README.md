# Railway

Use the conventional distribution with Railway PostgreSQL. Set the repository
root as the build context. No separate dashboard service is necessary.

- Build: `bun install --frozen-lockfile && bun run --filter @tenet/dashboard build && bun run --filter @tenet/server build`
- Pre-deploy: `bun apps/server/dist/auth.js migrate`
- Start: `node apps/server/dist/index.js` (or `bun apps/server/dist/index.js`)
- Health check: `/health`
- `DATABASE_URL`: reference the PostgreSQL service's private connection URL.
- `TENET_ORIGIN`: final public HTTPS origin, no trailing slash.
- `BETTER_AUTH_SECRET`: stable secret generated with `openssl rand -hex 32`.
- `HOST=0.0.0.0`
- `TENET_ASSETS_DIR=apps/dashboard/dist/client`
- `PORT`: provided by Railway.

Alternatively use `deploy/docker/Dockerfile` with the same variables and a
PostgreSQL service. The image uses Bun to run the Node-compatible bundle.

Once deployed, run `bun apps/server/dist/auth.js setup` inside the service's
runtime environment and use the one-use code on the dashboard. Generate and save
recovery codes after enrolling. Never put setup codes or auth secrets in frontend
variables. Run the `cleanup` administration command periodically, and configure
database backups. See [authentication](../../docs/authentication.md).

## Machine enrollment

Apply migration `0002_machines.sql` through the existing migration command. Before
building the dashboard, run `bun run bundle:daemon` on a build machine with Docker
and include the generated `apps/dashboard/public/daemon/` artifacts in your build
context/deployed assets. Git-only deployments do not include these gitignored
artifacts automatically. The panel must have a public HTTPS origin; `/api/*` and
`/daemon/*` must be reachable by the VPS. See [connecting machines](../../docs/machines.md).
