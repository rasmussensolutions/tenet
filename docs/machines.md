# Connecting machines

Tenet's first daemon release enrolls Linux machines and reports CPU usage, memory
usage, and disk usage per mount. It sends a fresh snapshot about every 15 seconds;
the panel considers it offline after 60 seconds without a report. The dashboard
polls every 15 seconds while visible. Offline machines retain their last sample,
clearly labelled as stale. This is current-state monitoring, not historical charts.

## Prepare the panel

1. Apply the new database migration (existing users and passkeys are preserved):

   ```sh
   bun --env-file=apps/server/.env run auth:admin migrate
   # Cloudflare alternative:
   bun run auth:admin migrate --worker --remote
   ```

2. Build the Linux artifacts with Docker/Buildx running, **before** building the
   dashboard. Docker Desktop includes the required architecture emulation:

   ```sh
   bun run bundle:daemon             # x86_64 and aarch64
   # Or only the architecture you use:
   bun run bundle:daemon x86_64
   bun run build
   ```

   This uses the committed Cargo lockfile and creates static musl binaries plus
   `manifest.json` (SHA-256 checksums) in `apps/dashboard/public/daemon/`. These
   generated artifacts are intentionally gitignored. Vite copies them to
   `apps/dashboard/dist/client/daemon/` for deployment. They must be part of the
   deployed assets, including when using Workers, Docker, or Railway. A deployment
   without artifacts still runs the dashboard, but cannot issue installer commands.

   For remote Git-based builds, bundle in your CI/build preparation and include
   these files in the image or uploaded dashboard assets. `bun run build` alone
   does not invoke Docker. Alternatively, the Node/Bun server can serve a prepared
   artifact directory using `TENET_DAEMON_DIST=/absolute/path/to/daemon`.
   `deploy/daemon/Dockerfile` also supports Buildx's local output for CI.

3. Serve the dashboard, `/api/*`, and `/daemon/*` at one **public HTTPS origin**.
   Configure `TENET_ORIGIN` to exactly that origin, without a trailing slash.
   A normal TLS reverse proxy, Railway HTTPS domain, or Worker domain works.
   Allow outbound HTTPS/DNS on the VPS. No inbound agent port is needed.

Changing the panel hostname also changes the WebAuthn relying party. Existing
localhost passkeys will not authenticate on a different hostname; use the documented
deployment-admin recovery flow to register a passkey on the new origin. Do not
change the origin casually on an existing production installation.

## Add your VPS

Open **Machines → Add machine**, enter a name, and verify your passkey. Copy the
command and run it on the VPS within ten minutes. It needs `sudo`, `curl`,
`sha256sum`, `useradd`, `runuser`, and a running systemd, as on typical Ubuntu/Debian
VPS installations. Currently supported CPUs are x86_64 and aarch64; only bundled
architectures are installable. The command also works directly as root without sudo.

The command downloads the installer to a temporary file. The installer downloads
the binary from **your panel**, verifies the pinned SHA-256 hash, creates the
`tenetd` system user, enrolls as that user, and installs/enables `tenetd.service`.
The machine appears as pending immediately, then connecting, then online once its
first sample arrives. The dashboard updates automatically.

The enrollment command contains a secret. It is shown once, not stored in browser
storage, and may remain in your clipboard or shell history. It expires in ten
minutes, can claim only one machine, and can be cancelled with Disconnect. Closing
the add sheet preserves the command until you leave the page; losing it means
cancelling that pending machine and generating another command.

```sh
sudo systemctl status tenetd
sudo journalctl -u tenetd --since '10 minutes ago'
```

The agent backs off on network/server failures, uses normal TLS certificate
validation, never follows redirects, and does not inherit HTTP proxy settings.
A revoked/rejected credential stops the agent with exit code 77; systemd does not
restart it in a loop. Fix network errors and it reconnects automatically, or use
`sudo systemctl restart tenetd` after correcting local configuration.

## Security boundary

- Browser list/enrollment/revocation routes use the existing owner session and
  origin checks. Issuing/revoking requires a passkey session less than five minutes
  old. The UI explicitly verifies with your passkey for each action.
- Enrollment tokens and machine credentials have 256 bits of OS-generated entropy.
  Only SHA-256 digests are stored on the panel. The daemon generates and persists
  its credential **before** sending it. Enrollment is an atomic SQL claim, portable
  to PostgreSQL and D1. A retry after a lost response is accepted only with the same
  credential and within the original token's lifetime; it cannot claim a second
  machine or change credentials.
- Machine bearer credentials authorize only their own telemetry and fixed update
  polling/reporting routes, never browser routes, arbitrary service actions, or
  other machines. Enrollment uses a separate one-use token. These exact agent
  POST routes accept requests without a browser Origin header. Other browser CSRF protections remain.
- Reports have a 32 KiB body limit, bounded/validated metrics, per-machine rate
  limits, and server-generated last-seen times. Incoming identity fields are ignored;
  the credential determines the machine. Revocation is checked again during writes.
- Credential files are mode 0600 in a private 0700 directory. Neither persistent
  credentials nor enrollment tokens are command-line arguments to the daemon.
  Identity files cannot be silently overwritten by another enrollment.
- The systemd agent runs as `tenetd`, without capabilities, with a read-only system,
  private temporary directory and devices, inaccessible home directories, and
  privilege escalation disabled. It collects only host metadata and resource
  metrics. There is no remote shell, arbitrary job execution, or Docker access. The optional
  root updater is a separate fixed-purpose helper; monitoring remains unprivileged.
- The installer runs as root to install a service. You trust your panel's TLS
  identity and its published installer/manifest. Checksums detect binary corruption
  or substitution relative to that manifest; this is **not** independent release
  signing or protection against a compromised panel serving both malicious code
  and a matching hash. After this initial trust bootstrap, the optional updater
  independently verifies signed releases against a root-owned pinned key. Updates
  require an explicit panel request and fresh owner authentication.
- A compromised monitored host can forge its own measurements. Monitoring does not
  provide hardware attestation. A stolen machine credential remains usable until
  revoked; disconnect and re-enroll to replace it.

Enrollment issuance, successful enrollment and revocation appear in security
activity. Telemetry is a single overwritten snapshot per machine. Keep normal edge
request limits on public deployments; application limits are not a DDoS service.
The current small-fleet implementation lists all machines and has a soft cap of
1,000 retained machine records, including pending and disconnected records.

## Disconnect, uninstall, or retry a failed installation

Disconnect on the Machines page first. This immediately invalidates its credential
and pending token, while leaving services on the VPS untouched. To remove Tenet
from the VPS (including a partial installation), run:

```sh
sudo systemctl disable --now tenetd.service  # May say missing if setup failed early
sudo rm -f /etc/systemd/system/tenetd.service /usr/local/bin/tenetd
sudo systemctl daemon-reload
sudo userdel tenetd                        # May say missing if setup failed early
sudo rm -rf /var/lib/tenetd
```

Only run this for the Tenet-created account/files. The installer deliberately refuses
to adopt an existing `tenetd` account or overwrite an identity. After cleanup, create
a new enrollment command. If enrollment was interrupted and the token is still
valid, the CLI can retry with the same private config and stdin token, but the full
installer intentionally refuses to reinstall over its partial state.

## Local development and checks

Real VPS enrollment requires public HTTPS. Loopback HTTP is allowed by the Rust
CLI **only for localhost development**; the dashboard never emits an HTTP VPS
installer command. For a deterministic isolated local integration check:

```sh
cargo build --locked -p tenetd
TENET_DAEMON_TEST_BINARY="$PWD/target/debug/tenetd" bun test packages/api/test/machines.test.ts
cargo test --workspace --locked
bun run check:daemon
```

The integration check starts a temporary loopback API with an isolated SQLite
(or `TEST_DATABASE_URL` PostgreSQL schema), enrolls the real daemon, ingests real
metrics, and revokes its credential. It never uses your owner account or machines.
`cargo run -p tenetd -- sample` prints one real metrics snapshot without connecting.

Unit/integration tests cover token races, expiry/replay, lost-response retries,
credential isolation, CSRF, stale authentication, revocation during writes,
malformed/oversized telemetry, offline status, rate limits, private identity
persistence, and installer shell syntax/integrity checks. CI also runs the real
agent/API flow on Linux. Installation on your particular VPS/systemd distribution
still needs an operator smoke test.

## Daily development with a stable tunnel

Configure a locally managed named Cloudflare Tunnel once, route a dedicated DNS
hostname to it, and copy `deploy/cloudflare/dev-tunnel.example.yml` to
`deploy/cloudflare/dev-tunnel.yml` with your tunnel ID, credential-file path and
hostname. The machine-specific configuration is gitignored. Set `TENET_ORIGIN`
in `apps/server/.env` to that exact HTTPS origin.

Then run from the repository root:

```sh
bun run dev:tunnel
```

This starts the existing `tenet-dev-db` container if stopped, applies migrations,
runs the API with watch mode, runs Vite on loopback port 3000, and connects the named
tunnel. Open the printed HTTPS URL every time. UI edits hot-reload without builds;
API edits restart automatically. Ctrl+C stops the dev processes, leaving the database
container running. Docker Desktop must already be running. Ports 3000 and 3002 must
be free. The landing-page development server is independent (`bun run dev:website`).

Moving from a previous hostname needs one owner recovery and VPS re-enrollment.
Subsequent restarts keep the same hostname, passkeys and machine configuration.
Use this address only for development: Vite serves frontend source and debugging
modules publicly through the tunnel. Server secrets remain outside frontend code.

### IP addresses

Updated agents report up to 64 local interface addresses, excluding loopback,
unspecified and multicast addresses. The table prefers a public IPv4 address and
then a public IPv6 address; Details lists the reported addresses and hostname.
Older agents remain compatible and show “IP unavailable” until upgraded. For a
host behind NAT without a public interface address, Tenet does not guess its public
IP or contact third-party IP lookup services. Interface reporting is not proof of
reachability or an SSH address.

To upgrade an existing agent, download the newly built binary from your panel's
`/daemon/tenetd-linux-x86_64` (or aarch64) endpoint, verify its SHA-256 against the
panel's `/daemon/manifest.json`, stop `tenetd`, replace `/usr/local/bin/tenetd` with
root ownership and mode 0755, and start `tenetd` again. Preserve
`/var/lib/tenetd/identity.json`; no new enrollment is needed for a binary upgrade.

## Signed daemon updates

See [Daemon updates](updates.md) to configure signed releases and enable passkey-confirmed updates from the Machines page. Existing installations need the one-time updater bootstrap command shown in machine details.
