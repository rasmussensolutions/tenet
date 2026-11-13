# Docker Compose

This distribution contains the dashboard/API and PostgreSQL. Put the panel behind
an HTTPS reverse proxy. It binds only to host loopback by default; do not expose
the PostgreSQL port publicly.

Create a private environment file (outside version control) containing:

```dotenv
TENET_ORIGIN=https://panel.example.com
TENET_DB_PASSWORD=<generate with openssl rand -hex 32>
BETTER_AUTH_SECRET=<generate another with openssl rand -hex 32>
```

Use hex for the database password so it is safe in the connection URL. Then, from
the repository root:

```sh
docker compose --env-file /path/to/private.env -f deploy/docker/compose.yaml build
docker compose --env-file /path/to/private.env -f deploy/docker/compose.yaml up -d database
docker compose --env-file /path/to/private.env -f deploy/docker/compose.yaml run --rm panel bun apps/server/dist/auth.js migrate
docker compose --env-file /path/to/private.env -f deploy/docker/compose.yaml up -d panel
docker compose --env-file /path/to/private.env -f deploy/docker/compose.yaml exec panel bun apps/server/dist/auth.js setup
```

Open the configured origin through your HTTPS reverse proxy and enter the setup
code. The panel runs as a non-root user with a read-only filesystem; PostgreSQL
persists in a named volume. Migrations are explicit, never applied implicitly by
web requests. Back up the database volume and environment secrets.

Use the same `exec ... auth.js` command with `recover` for deployment-level
recovery or `cleanup` for retention maintenance. Run `migrate` before starting an
updated application image. `/health` is the liveness endpoint.

## Machine enrollment

Apply migration `0002_machines.sql` through the existing migration command. Before
building the dashboard, run `bun run bundle:daemon` on a build machine with Docker
and include the generated `apps/dashboard/public/daemon/` artifacts in your build
context/deployed assets. Git-only deployments do not include these gitignored
artifacts automatically. The panel must have a public HTTPS origin; `/api/*` and
`/daemon/*` must be reachable by the VPS. See [connecting machines](../../docs/machines.md).
