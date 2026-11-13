import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { createFileRoute } from "@tanstack/react-router";
import type { Machine, MachineList } from "@tenet/api/machines";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, signIn } from "@/lib/auth";
import { primaryAddress } from "@/lib/machine-address";

export const Route = createFileRoute("/_authenticated/machines")({
  head: () => ({ meta: [{ title: "Machines — Tenet" }] }),
  loader: () => api<MachineList>("/machines"),
  component: MachinesPage,
});

interface Enrollment {
  id: string;
  command: string;
  expiresAt: number;
}

function MachinesPage() {
  const initial = Route.useLoaderData();
  const [data, setData] = useState(initial);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState(false);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setData(initial);
  }, [initial]);
  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      if (document.visibilityState === "visible") {
        try {
          const next = await api<MachineList>("/machines");
          if (active) {
            setData(next);
            setPollError(false);
          }
        } catch {
          if (active) setPollError(true);
        }
      }
      if (active) timeout = setTimeout(poll, 15_000);
    }
    timeout = setTimeout(poll, 15_000);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, []);
  useEffect(() => {
    if (!enrollment) return;
    const timeout = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timeout);
  }, [enrollment]);

  const enrolledMachine = data.machines.find(
    (machine) => machine.id === enrollment?.id,
  );
  const connected =
    enrolledMachine?.status === "online" ||
    enrolledMachine?.status === "connecting";
  const expired = enrollment !== null && now >= enrollment.expiresAt;
  const revoked = enrolledMachine?.status === "revoked";
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setData(await api<MachineList>("/machines"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  async function revoke(machine: Machine) {
    if (
      !confirm(
        `Disconnect “${machine.name}”? Its credential and any pending enrollment command will stop working. Services on the VPS will keep running.`,
      )
    )
      return;
    await run(async () => {
      await signIn();
      await api("/machines/revoke", { id: machine.id });
      setNotice(`${machine.name} disconnected.`);
    });
  }
  async function update(machine: Machine) {
    if (
      !confirm(
        `Update the Tenet daemon on “${machine.name}” to ${data.releaseInfo?.release?.version}? Monitoring will briefly restart. Your services will keep running.`,
      )
    )
      return;
    await run(async () => {
      await signIn();
      await api("/machines/updates", { id: machine.id });
      setNotice(`Update queued for ${machine.name}. Progress appears below.`);
    });
  }
  const feedback = (
    <>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </>
  );
  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Machines</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your servers, their health, and resources at a glance.
          </p>
        </div>
        <Button
          onClick={() => {
            setOpen(true);
            setError("");
            setNotice("");
          }}
        >
          <PlusIcon />
          Add machine
        </Button>
      </div>
      {!open && feedback}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
        <div className="space-y-1">
          <p className="font-medium">
            Daemon updates
            {data.releaseInfo?.release
              ? ` · Latest ${data.releaseInfo.release.version}`
              : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {!data.releaseInfo?.configured
              ? "Updates are not configured on this panel. See docs/updates.md for release setup."
              : data.releaseInfo.error ||
                (data.releaseInfo.release
                  ? "Signed releases. Install updates individually after confirming with your passkey."
                  : "No compatible signed release is available.")}
          </p>
        </div>
        {data.releaseInfo?.configured && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api("/machines/updates/check", {});
              })
            }
          >
            Check for updates
          </Button>
        )}
      </div>
      {pollError && (
        <p
          role="alert"
          className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground"
        >
          Could not refresh machines. Values may be out of date. Retrying
          automatically.
        </p>
      )}
      {data.machines.length === 0 ? (
        <div className="flex flex-col items-center rounded-xl border bg-card px-6 py-16 text-center shadow-xs">
          <HardDrivesIcon
            className="mb-4 size-8 text-muted-foreground"
            weight="duotone"
          />
          <h2 className="font-medium">Connect your first machine</h2>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">
            Run a command on your Linux VPS to start monitoring CPU, memory, and
            disk usage.
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => setOpen(true)}
          >
            Add machine
          </Button>
        </div>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-xs">
          <Table>
            <caption className="sr-only">
              Machines and their latest resource usage
            </caption>
            <TableHeader>
              <TableRow>
                {[
                  "Machine",
                  "Status",
                  "CPU",
                  "Memory",
                  "Disk /",
                  "Last seen",
                  "Daemon",
                ].map((title) => (
                  <TableHead key={title} scope="col">
                    {title}
                  </TableHead>
                ))}
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.machines.map((machine) => (
                <MachineRow
                  key={machine.id}
                  machine={machine}
                  busy={busy}
                  releaseInfo={data.releaseInfo}
                  job={data.updates?.find(
                    (job) => job.machine_id === machine.id,
                  )}
                  update={() => void update(machine)}
                  revoke={() => void revoke(machine)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Metrics refresh every 15 seconds. Machines are marked offline after one
        minute without a report.
      </p>
      <Sheet
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <SheetContent className="w-full! max-w-xl! overflow-y-auto overscroll-y-none p-2">
          <SheetHeader>
            <SheetTitle>Add a machine</SheetTitle>
            <SheetDescription>
              Connect a Linux VPS with systemd. No inbound ports are needed.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-6 px-4 pb-6">
            {feedback}
            {!data.installer.available && (
              <div className="space-y-2 rounded-lg border bg-background p-4 text-sm">
                <p className="font-medium">Prepare your panel first</p>
                {!data.installer.https && (
                  <p className="text-muted-foreground">
                    Your VPS needs to reach this panel over HTTPS. Configure
                    TENET_ORIGIN with your public HTTPS address; localhost on
                    your VPS points to the VPS itself.
                  </p>
                )}
                {!data.installer.architectures.length && (
                  <p className="text-muted-foreground">
                    This deployment does not have a Linux agent build yet. Run{" "}
                    <code className="text-foreground">
                      bun run bundle:daemon
                    </code>{" "}
                    in the project before building and deploying the dashboard.
                    See <code>docs/machines.md</code> for setup instructions.
                  </p>
                )}
              </div>
            )}
            {enrollment && connected ? (
              <div className="space-y-2 rounded-xl border bg-card p-5">
                <h3 className="font-medium">
                  {enrolledMachine?.name} is connected
                </h3>
                <p className="text-sm text-muted-foreground">
                  {enrolledMachine?.status === "online"
                    ? "Your machine is reporting metrics."
                    : "Waiting for its first metrics report."}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    setEnrollment(null);
                    setName("");
                    setOpen(false);
                  }}
                >
                  Done
                </Button>
              </div>
            ) : enrollment && !expired && !revoked ? (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-medium">Run this on your VPS</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Installs Tenet as an unprivileged monitoring service. You
                    need sudo access, curl, and systemd.
                  </p>
                </div>
                <pre className="max-w-full overflow-x-auto rounded-lg border bg-background p-4 text-xs leading-6 whitespace-pre-wrap break-all select-all">
                  {enrollment.command}
                </pre>
                <Button
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(enrollment.command);
                      setNotice("Command copied.");
                    } catch {
                      setError(
                        "Copy failed. Select and copy the command manually.",
                      );
                    }
                  }}
                >
                  Copy command
                </Button>
                <p className="text-xs text-muted-foreground">
                  Single use · expires in{" "}
                  {Math.max(
                    0,
                    Math.ceil((enrollment.expiresAt - now) / 60_000),
                  )}{" "}
                  minutes. Treat this command as a secret until it expires. The
                  page updates automatically when your VPS connects.
                </p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    enrolledMachine && void revoke(enrolledMachine)
                  }
                >
                  Cancel enrollment
                </Button>
              </div>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    await signIn();
                    const result = await api<Enrollment>(
                      "/machines/enrollments",
                      { name: name.trim() },
                    );
                    setNow(Date.now());
                    setEnrollment(result);
                  });
                }}
              >
                {enrollment && (
                  <p role="status" className="text-sm text-muted-foreground">
                    This enrollment has {revoked ? "been cancelled" : "expired"}
                    . Generate a new command to continue.
                  </p>
                )}
                <div className="space-y-2">
                  <label htmlFor="machine-name" className="text-sm font-medium">
                    Machine name
                  </label>
                  <Input
                    id="machine-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                    placeholder="Production VPS"
                    autoComplete="off"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={busy || !data.installer.available || !name.trim()}
                >
                  {busy ? "Verifying…" : "Verify & generate command"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Confirm with your passkey to create a ten-minute enrollment
                  command.
                </p>
              </form>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function bytes(value: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const index = Math.min(
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
    units.length - 1,
  );
  return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}
function Usage({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number;
  detail: string;
}) {
  return (
    <div
      className="flex items-center gap-3 whitespace-nowrap"
      title={`${label}: ${detail}`}
    >
      <span aria-hidden="true" className="flex gap-1">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((index) => (
          <span
            key={`dot-${index}`}
            className={`size-1.5 rounded-full ${index < Math.ceil((percent / 100) * 12) ? (percent >= 90 ? "bg-destructive" : "bg-foreground/65") : "bg-foreground/10"}`}
          />
        ))}
      </span>
      <span className="ml-auto font-mono text-xs tabular-nums">
        <span className="sr-only">{label}: </span>
        {percent.toFixed(1)}%
      </span>
    </div>
  );
}
function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function MachineRow({
  machine,
  busy,
  revoke,
  update,
  releaseInfo,
  job,
}: {
  machine: Machine;
  busy: boolean;
  revoke: () => void;
  update: () => void;
  releaseInfo: MachineList["releaseInfo"];
  job: NonNullable<MachineList["updates"]>[number] | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const metrics = machine.telemetry;
  const root = metrics?.disks.find((disk) => disk.mount === "/");
  const labels: Record<string, string> = {
    pending: "Awaiting enrollment",
    connecting: "Waiting for metrics",
    online: "Online",
    offline: "Offline",
    revoked: "Disconnected",
    expired: "Enrollment expired",
  };
  const latest = releaseInfo?.release;
  const version = metrics?.agentVersion;
  const newer =
    latest &&
    version &&
    /^\d+\.\d+\.\d+$/.test(version) &&
    latest.version
      .split(".")
      .map(Number)
      .some(
        (part, index, parts) =>
          parts
            .slice(0, index)
            .every((v, i) => v === Number(version.split(".")[i])) &&
          part > Number(version.split(".")[index]),
      );
  const activeJob =
    job && ["queued", "downloading", "installing"].includes(job.status);
  const enabled =
    releaseInfo?.publicKey &&
    machine.updaterKey === releaseInfo.publicKey &&
    Number(machine.updaterSeen) > Date.now() - 180000;
  const compatible =
    latest && metrics && latest.artifacts[metrics.arch as "x86_64" | "aarch64"];
  const canUpdate =
    machine.status === "online" && enabled && compatible && newer && !activeJob;
  const updateLabels: Record<string, string> = {
    queued: "Queued",
    downloading: "Downloading…",
    installing: "Installing…",
    succeeded: "Updated",
    rolled_back: "Rolled back",
    failed: "Update failed",
    expired: "Completion unknown",
  };
  const detailsId = `machine-details-${machine.id}`;
  return (
    <>
      <TableRow className="[&>td]:border-l [&>td]:py-3">
        <TableHead scope="row" className="max-w-72 py-3 text-foreground">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${machine.status === "online" ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
            />
            <span className="truncate text-sm font-medium">{machine.name}</span>
            <span className="truncate font-mono text-xs font-normal text-muted-foreground">
              {primaryAddress(metrics?.ipAddresses) ?? "IP unavailable"}
            </span>
            <span className="sr-only">Show machine details</span>
          </button>
        </TableHead>
        <TableCell
          className="whitespace-nowrap text-xs text-muted-foreground"
          title={
            metrics && machine.status !== "online"
              ? "Usage shows last reported values, not live metrics."
              : undefined
          }
        >
          {labels[machine.status]}
        </TableCell>
        <TableCell>
          {metrics ? (
            <Usage
              label="CPU"
              percent={metrics.cpuPercent}
              detail={`${metrics.cpuCount} ${metrics.cpuCount === 1 ? "core" : "cores"}`}
            />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          {metrics ? (
            <Usage
              label="Memory"
              percent={(metrics.memoryUsed / metrics.memoryTotal) * 100}
              detail={`${bytes(metrics.memoryUsed)} / ${bytes(metrics.memoryTotal)}`}
            />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell>
          {root ? (
            <Usage
              label="Root filesystem /"
              percent={(root.used / root.total) * 100}
              detail={`${bytes(root.used)} / ${bytes(root.total)}`}
            />
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
          {machine.lastSeen ? (
            <time
              title={new Date(machine.lastSeen).toLocaleString()}
              dateTime={new Date(machine.lastSeen).toISOString()}
            >
              {relativeTime(machine.lastSeen)}
            </time>
          ) : (
            "Never"
          )}
        </TableCell>
        <TableCell className="whitespace-nowrap text-xs">
          <div className="flex items-center gap-3">
            <span className="font-mono text-muted-foreground">
              {version || "—"}
            </span>
            {activeJob ? (
              <span role="status">{updateLabels[job.status]}</span>
            ) : canUpdate ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={update}
              >
                Update to {latest?.version}
              </Button>
            ) : job &&
              ["failed", "rolled_back", "expired"].includes(job.status) ? (
              <span className="text-destructive">
                {updateLabels[job.status]}
              </span>
            ) : newer ? (
              <span className="text-muted-foreground">Update available</span>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="text-right">
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Close" : "Details"}
          </Button>
        </TableCell>
      </TableRow>
      <TableRow
        id={detailsId}
        hidden={!expanded}
        className="bg-muted/15 hover:bg-muted/15"
      >
        <TableCell colSpan={8}>
          <div className="flex flex-wrap items-start justify-between gap-6 py-1">
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {metrics
                  ? `${metrics.hostname} · ${metrics.os} · ${metrics.arch} · ${metrics.cpuCount} ${metrics.cpuCount === 1 ? "core" : "cores"} · ${bytes(metrics.memoryTotal)} RAM`
                  : "No metrics received."}
                {metrics &&
                  machine.status !== "online" &&
                  " · Last reported values"}
              </p>
              {metrics && (
                <div className="space-y-2">
                  <p className="text-xs font-medium">Daemon updates</p>
                  <p className="text-xs text-muted-foreground">
                    {!releaseInfo?.configured
                      ? "Release updates are not configured."
                      : enabled
                        ? compatible
                          ? newer
                            ? `Version ${latest?.version} is available.`
                            : "No newer compatible version is available."
                          : "No release is available for this architecture."
                        : machine.updaterKey
                          ? "Updater is not responding or trusts a different signing key. Check tenet-updater on the VPS."
                          : "Enable the updater once on this VPS to receive signed updates from your panel."}
                  </p>
                  {job && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {updateLabels[job.status]} · {job.version}
                      {job.error ? ` · ${job.error}` : ""}
                    </p>
                  )}
                  {!machine.updaterKey &&
                    machine.status !== "revoked" &&
                    releaseInfo?.configured &&
                    (releaseInfo.bootstrapCommand ? (
                      <div className="max-w-2xl space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Run once on this VPS with sudo access:
                        </p>
                        <pre className="overflow-x-auto rounded-md border bg-background p-3 text-xs whitespace-pre-wrap break-all select-all">
                          {releaseInfo.bootstrapCommand}
                        </pre>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Bundle the new daemon build on your panel to make the
                        updater setup command available.
                      </p>
                    ))}
                  <p className="text-xs font-medium">IP addresses</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {metrics.ipAddresses?.join(" · ") ||
                      "Not reported by this agent. Upgrade the daemon to report interface addresses."}
                  </p>
                  <p className="text-xs font-medium">Mounted filesystems</p>
                  {metrics.disks.map((disk) => (
                    <div
                      key={disk.mount}
                      className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs"
                    >
                      <span className="min-w-24 font-mono">{disk.mount}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {bytes(disk.used)} / {bytes(disk.total)}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {((disk.used / disk.total) * 100).toFixed(1)}%
                      </span>
                    </div>
                  ))}
                  {!metrics.disks.length && (
                    <p className="text-xs text-muted-foreground">
                      No filesystems reported.
                    </p>
                  )}
                </div>
              )}
            </div>
            {machine.status !== "revoked" && (
              <Button
                variant="outline"
                size="sm"
                aria-label={`Disconnect ${machine.name}`}
                disabled={busy}
                onClick={revoke}
              >
                Disconnect machine
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    </>
  );
}
