# Daemon updates

Tenet supports owner-triggered updates of the **monitoring daemon**, not operating-system packages or services deployed on the VPS. The panel can run on Docker, Railway, or Cloudflare Workers; update jobs and progress live in PostgreSQL or D1. Each VPS polls outbound over HTTPS. No SSH credentials or inbound agent port are required.

## Release setup (maintainer, once)

1. Generate a release signing key outside the repository, or in the ignored `.release-keys` directory:

   ```sh
   bun run release:daemon keygen .release-keys
   ```

   Back up `private.pem` securely. Never put it on a panel or VPS, commit it, or include it in a container image. `public-key.txt` is safe to distribute. A self-hoster using official builds needs only the official public key and release URL; a fork can generate its own key.

2. Push this repository to GitHub. Use public release assets: private GitHub downloads require authentication and cannot be used directly by the VPS updater. Create a protected GitHub Actions environment named `daemon-release`, with required reviewers and restrictions on release tags. Put the contents of `private.pem` in its `TENET_RELEASE_SIGNING_KEY` secret. Restrict who can push release tags and change the workflow. Enable GitHub immutable releases for the repository. See [GitHub environment protection](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) and [immutable release publishing](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository). These protections are repository settings; the workflow cannot configure them for you.

3. Set the workspace version in `Cargo.toml` (currently `0.1.0`), update `Cargo.lock`, commit, and push a matching tag such as `daemon-v0.1.0`. `.github/workflows/daemon-release.yml` tests and builds static Linux x86_64 and aarch64 executables, signs `release.json`, and publishes the assets. Every release must have a **strictly higher** numeric version. Never rebuild or replace assets under an existing version.

4. Configure both variables on each panel and restart/redeploy it:

   ```dotenv
   TENET_RELEASE_URL=https://github.com/OWNER/REPO/releases/latest/download/release.json
   TENET_RELEASE_PUBLIC_KEY=<contents of public-key.txt>
   ```

   Use a repository whose latest release is a daemon release. If you publish unrelated panel releases in the same repository, use a separate daemon release repository or a dedicated stable manifest URL on your own HTTPS host/R2 custom domain. The stable URL may move; the artifact URLs inside each signed manifest must stay version-specific. The panel and updater verify signatures independently, so a mirror cannot substitute its own binaries.

5. Apply the database migration before starting the new panel:

   ```sh
   bun run auth:admin migrate
   # Cloudflare D1 instead:
   bun run auth:admin migrate --worker --remote
   ```

   `bun run dev:tunnel` already runs migrations on startup. Docker and Railway operators should run the migration as part of their deployment procedure. Docker Compose forwards the two optional release environment variables. Workers users set them as Worker variables (the public key is not a secret).

## Enable updates on a VPS

Bundle a daemon that includes updater protocol 1 before building/deploying your dashboard:

```sh
bun run bundle:daemon
```

The deployment bundles binaries and checksums for the initial installer. With the release variables configured, new machine installations also install the updater. On an existing machine, open **Machines → Details** and run the displayed one-time updater command on that VPS. It preserves the machine identity and currently installed daemon. It pins the configured public key in root-owned `/etc/tenet/updater.json`; the daemon cannot replace that key. The bootstrap command initially trusts your HTTPS panel, just like enrollment, so obtain it from your own trusted panel.

Within roughly 35 seconds, the updater reports readiness. **Update to …** appears for an online machine with an older version and a compatible signed artifact. Click it, confirm, and verify with your passkey. The table shows queued, downloading, installing, or the result. Machines without an updater, with a different pinned key, or without a compatible architecture do not get an actionable update button. There are no unattended automatic installs.

## What is verified

- Ed25519 signature over the exact UTF-8 manifest bytes; pinned trust on both panel and VPS.
- Manifest schema, stable channel, protocol compatibility, expiry, architecture, and a strictly newer numeric version.
- HTTPS transport using the operating system's trusted CA certificates; no environment proxy, credential forwarding to artifacts, or HTTP redirects for agent API calls.
- Artifact SHA-256 and exact size, with a 32 MiB maximum, before replacement.
- Root ownership and permissions for state and executable paths. The root helper has fixed paths and a fixed `systemctl restart tenetd.service` operation; it does not accept shell commands from the panel.
- The new daemon must send fresh telemetry with the expected version **and build identity** before the update succeeds. Binary versions/build IDs come from the build inputs, not a user-editable panel field.

The monitoring service remains unprivileged. The separate root helper is installed at `/usr/local/libexec/tenet-updater` and runs from `tenet-updater.timer`. It verifies and downloads before staging an atomic rename on the same filesystem. A root-only journal and backup survive restarts. A failed restart or missing health report restores the previous executable and restarts monitoring. An interrupted installation is rolled back on the helper's next run, even if the panel is unavailable. Lost completion responses are retried without reinstalling the same job. Only one update runs at a time per machine.

The helper itself is deliberately **not** replaced by panel-triggered daemon updates. Updating its trust logic or rotating the signing key requires a separate local administrator action. Do not remove its journal or change its pinned key while an update is running.

Release metadata expires after 90 days. Publish a newer release before expiry; expired manifests cannot authorize new installs. Existing agents continue monitoring. A compromised signing key can authorize malicious releases, so key custody and release-review protections are essential. Signing does not make malicious signed code safe.

## Failure recovery

Check these on the VPS:

```sh
sudo systemctl status tenet-updater.timer tenet-updater.service tenetd.service
sudo journalctl -u tenet-updater.service -u tenetd.service --since '20 minutes ago'
```

A failed download leaves the existing binary intact. A rolled-back update retains the previous version and may be retried after resolving the failure. Requests expire after 15 minutes; **Completion unknown** means the panel has not received a final receipt. Inspect the VPS before retrying. A later receipt reconciles the status. Network loss during health verification causes a conservative rollback.

If restoring or restarting also fails (disk errors, changed systemd unit, permission problems), the helper leaves its journal intact and tries recovery again on its next run. Resolve the host problem before requesting another update. The verified backup is `/var/lib/tenet-updater/previous`; do not blindly replace it with an unverified download.

Revoking a machine prevents subsequent polling and API reports. It cannot cancel a binary replacement that the updater has already started. Updates restart only `tenetd.service`, not Docker, your applications, or the VPS.

## Publishing somewhere other than GitHub

Build, then sign with version-specific HTTPS artifact URLs:

```sh
bun run bundle:daemon
TENET_RELEASE_SIGNING_KEY_FILE=.release-keys/private.pem \
  bun run release:daemon sign apps/dashboard/public/daemon \
  https://downloads.example.com/daemon/0.1.0/ \
  /tmp/tenet-release.json
```

Upload the binaries to those version-specific URLs, then publish the signed file at the panel's configured stable manifest URL. Do not regenerate the signed JSON or alter its embedded `manifest` string. The signing command checks bundled binary checksums and verifies its own signature before writing. It refuses to overwrite an existing output file.

## Validation

`bun run test` covers signature validation, API authorization, queue concurrency, cross-machine isolation, expiry, and receipts on SQLite (and PostgreSQL when `TEST_DATABASE_URL` is set). `cargo test --workspace --locked` checks daemon signature and version handling.

The optional Linux integration test runs the production executable against the real API over verified HTTPS in an unprivileged Docker container. It checks a successful update, lost receipt retry, artifact tampering, failed-binary rollback, restrictive umask, and crash recovery. Only the systemd restart command is replaced by a harness that launches the real daemon under its unprivileged user; this does not substitute for testing actual systemd sandboxing on a deployment VPS.

```sh
bun run bundle:daemon x86_64
docker build --platform linux/amd64 -t tenet-updater-test -f deploy/daemon/test.Dockerfile .
TENET_TEST_LINUX_UPDATER=1 bun test packages/api/test/updater-linux.test.ts
```

## This repository

Official release repository: [rasmussensolutions/tenet](https://github.com/rasmussensolutions/tenet).

```dotenv
TENET_RELEASE_URL=https://github.com/rasmussensolutions/tenet/releases/latest/download/release.json
TENET_RELEASE_PUBLIC_KEY=69fcf97385688a836880535bad05d49fcf2b4a09bd54315546c458efe3d53b2b
```

Verify the public key against a trusted copy before bootstrapping a VPS. The release signing key is kept separately from the source and panel configuration.
