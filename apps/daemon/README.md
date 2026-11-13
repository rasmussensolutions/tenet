# tenetd

The Tenet monitoring agent. Runs as an unprivileged Linux systemd service and sends
CPU, memory, and per-mount disk usage to the panel over outbound HTTPS. The panel
can run on Bun/Node/PostgreSQL or Cloudflare Workers/D1.

```sh
cargo run -p tenetd -- --help
cargo run -p tenetd -- sample
cargo test --workspace --locked
bun run check:daemon
bun run bundle:daemon  # Builds Linux x86_64/aarch64 installer artifacts with Docker
```

Use **Machines → Add machine** for a short-lived enrollment command. See
[connecting machines](../../docs/machines.md) for panel preparation, installation,
security boundaries, troubleshooting, and uninstall instructions.

`config.rs` owns private credential persistence and origin validation;
`metrics.rs` samples only the required host resources; `main.rs` owns CLI commands,
HTTPS enrollment, retries and the telemetry loop. Credentials never appear in
logs, URL query parameters, or process arguments. The agent has no remote command
execution. `updater.rs` provides the separate root helper for owner-approved,
signed updates, atomic replacement, and rollback. See [daemon updates](../../docs/updates.md).

`hosting.rs` detects cloud providers using fixed instance metadata endpoints in a
background worker. It reports only provider, region and zone, without contacting
external IP lookup services. See [provider detection](../../docs/machines.md#provider-detection).
