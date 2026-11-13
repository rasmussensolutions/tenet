import { AuthError } from "../auth/store";
import { HEX_KEY } from "./releases";

export interface DaemonRelease {
  updaterProtocol?: 1;
  x86_64?: string;
  aarch64?: string;
}
export function releaseManifest(value: unknown): DaemonRelease {
  if (!value || typeof value !== "object")
    throw new AuthError("DAEMON_NOT_AVAILABLE", 503);
  const manifest = value as Record<string, unknown>;
  const result: DaemonRelease = {};
  for (const arch of ["x86_64", "aarch64"] as const) {
    const digest = manifest[arch];
    if (typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))
      result[arch] = digest;
  }
  if (!result.x86_64 && !result.aarch64)
    throw new AuthError("DAEMON_NOT_AVAILABLE", 503);
  if (manifest.updaterProtocol === 1) result.updaterProtocol = 1;
  return result;
}
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function installCommand(origin: string, token: string) {
  // sudo authenticates before the pipe, so it cannot consume the enrollment token as a password.
  return String.raw`(set -eu; installer=$(mktemp); trap 'rm -f "$installer"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/install.sh`)} -o "$installer"; token=${shellQuote(token)}; if [ "$(id -u)" = 0 ]; then printf '%s\n' "$token" | sh "$installer"; else sudo -v; printf '%s\n' "$token" | sudo sh "$installer"; fi)`;
}

export function installer(
  origin: string,
  release: DaemonRelease,
  publicKey?: string,
) {
  if (!origin.startsWith("https://"))
    throw new AuthError("HTTPS_REQUIRED", 409);
  return `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo 'Run this installer through sudo.' >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo 'Linux is required.' >&2; exit 1; }
for cmd in curl sha256sum systemctl useradd runuser; do
  command -v "$cmd" >/dev/null || { echo "Missing required command: $cmd" >&2; exit 1; }
done
systemctl show-environment >/dev/null || { echo 'A running systemd is required.' >&2; exit 1; }
[ ! -e /etc/systemd/system/tenetd.service ] && [ ! -e /var/lib/tenetd/identity.json ] && [ ! -e /usr/local/bin/tenetd ] || {
  echo 'Tenet is already installed. Revoke the old machine and follow the documented reinstall procedure.' >&2; exit 1;
}
case "$(uname -m)" in
  x86_64) arch=x86_64; expected=${shellQuote(release.x86_64 ?? "")} ;;
  aarch64|arm64) arch=aarch64; expected=${shellQuote(release.aarch64 ?? "")} ;;
  *) echo 'Only x86_64 and aarch64 are supported.' >&2; exit 1 ;;
esac
[ -n "$expected" ] || { echo 'This panel has no daemon build for your CPU architecture.' >&2; exit 1; }
IFS= read -r token
[ "$(printf %s "$token" | wc -c)" -eq 64 ] || { echo 'Invalid enrollment token.' >&2; exit 1; }
case "$token" in *[!a-f0-9]*) echo 'Invalid enrollment token.' >&2; exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 300 ${shellQuote(`${origin}/daemon/`)}"tenetd-linux-$arch" -o "$tmp/tenetd"
printf '%s  %s\n' "$expected" "$tmp/tenetd" | sha256sum --check --status || { echo 'Daemon checksum verification failed.' >&2; exit 1; }
# Refuse to adopt a pre-existing account; its ownership and privileges are unknown.
if id tenetd >/dev/null 2>&1; then
  echo 'The tenetd account already exists. Follow the documented reinstall procedure.' >&2; exit 1
fi
useradd --system --user-group --home-dir /var/lib/tenetd --shell /usr/sbin/nologin tenetd
install -d -o tenetd -g tenetd -m 0700 /var/lib/tenetd
install -o root -g root -m 0755 "$tmp/tenetd" /usr/local/bin/tenetd
printf '%s\n' "$token" | runuser -u tenetd -- /usr/local/bin/tenetd enroll --panel ${shellQuote(origin)} --config /var/lib/tenetd/identity.json
unset token
cat > /etc/systemd/system/tenetd.service <<'UNIT'
[Unit]
Description=Tenet machine monitoring agent
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=tenetd
Group=tenetd
ExecStart=/usr/local/bin/tenetd run --config /var/lib/tenetd/identity.json
Restart=on-failure
RestartSec=15
RestartPreventExitStatus=77
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=
# getifaddrs uses netlink to read local interface addresses on Linux.
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/tenetd.service
systemctl daemon-reload
systemctl enable --now tenetd.service
${publicKey && release.updaterProtocol === 1 ? updaterSetup(origin, publicKey, "/usr/local/bin/tenetd") : ""}
echo 'Tenet connected. Metrics will appear shortly. Check status with: systemctl status tenetd'
`;
}

// Initial trust is provisioned by an explicit administrator action on the VPS.
export function updaterCommand(origin: string) {
  return `(set -eu; installer=$(mktemp); trap 'rm -f "$installer"' EXIT; curl --fail --silent --show-error --proto '=https' ${shellQuote(`${origin}/api/agent/updater.sh`)} -o "$installer"; if [ "$(id -u)" = 0 ]; then sh "$installer"; else sudo sh "$installer"; fi)`;
}
function updaterSetup(origin: string, key: string, source: string) {
  if (!HEX_KEY.test(key)) throw new AuthError("UPDATES_NOT_CONFIGURED", 503);
  return `
[ ! -e /etc/tenet/updater.json ] || { echo 'Updater already configured. Trust changes require local administration.' >&2; exit 1; }
version=$(runuser -u tenetd -- /usr/local/bin/tenetd --version)
version="\${version#tenetd }"
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 ${source} /usr/local/libexec/tenet-updater
/usr/local/libexec/tenet-updater configure-updater ${shellQuote(key)} ${shellQuote(origin)} "$version"
cat > /etc/systemd/system/tenet-updater.service <<'UNIT'
[Unit]
Description=Tenet signed daemon updater
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
User=root
ExecStart=/usr/local/libexec/tenet-updater update-worker
TimeoutStartSec=12min
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/usr/local/bin /var/lib/tenet-updater
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UNIT
cat > /etc/systemd/system/tenet-updater.timer <<'UNIT'
[Unit]
Description=Check for owner-approved Tenet updates
[Timer]
OnBootSec=30s
OnUnitInactiveSec=30s
RandomizedDelaySec=5s
AccuracySec=1s
[Install]
WantedBy=timers.target
UNIT
chmod 0644 /etc/systemd/system/tenet-updater.service /etc/systemd/system/tenet-updater.timer
systemctl daemon-reload
systemctl enable --now tenet-updater.timer
systemctl start --no-block tenet-updater.service
`;
}
export function updaterInstaller(
  origin: string,
  release: DaemonRelease,
  key?: string,
) {
  if (!origin.startsWith("https://") || !key || release.updaterProtocol !== 1)
    throw new AuthError("UPDATER_NOT_AVAILABLE", 503);
  return `#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ] || { echo 'Linux and root are required.' >&2; exit 1; }
[ -f /var/lib/tenetd/identity.json ] && [ -f /etc/systemd/system/tenetd.service ] || { echo 'Enroll this machine first.' >&2; exit 1; }
[ ! -e /etc/tenet/updater.json ] || { echo 'Updater already configured.' >&2; exit 1; }
systemctl show-environment >/dev/null
case "$(uname -m)" in
  x86_64) arch=x86_64; expected=${shellQuote(release.x86_64 ?? "")} ;;
  aarch64|arm64) arch=aarch64; expected=${shellQuote(release.aarch64 ?? "")} ;;
  *) exit 1 ;;
esac
[ -n "$expected" ] || { echo 'No updater build for this architecture.' >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 300 ${shellQuote(`${origin}/daemon/`)}"tenetd-linux-$arch" -o "$tmp/tenetd"
printf '%s  %s\\n' "$expected" "$tmp/tenetd" | sha256sum --check --status
${updaterSetup(origin, key, '"$tmp/tenetd"')}
echo 'Updater enabled. Return to Machines to install the latest signed daemon release.'
`;
}
