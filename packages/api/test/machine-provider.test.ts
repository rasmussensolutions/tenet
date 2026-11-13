import { expect, test } from "bun:test";
import { randomToken } from "../src/auth/store";
import { MachineStore, telemetry } from "../src/machines/store";
import { Browser, enrolled } from "./helpers";

const sample = {
  version: 1,
  hostname: "test",
  os: "Linux",
  arch: "x86_64",
  agentVersion: "0.1.2",
  cpuCount: 1,
  cpuPercent: 0,
  memoryTotal: 100,
  memoryUsed: 10,
  uptime: 1,
  disks: [],
};

test("hosting telemetry is bounded, allowlisted, and compatible with old daemons", () => {
  expect(telemetry(sample).hosting).toBeUndefined();
  expect(telemetry({ ...sample, hosting: null }).hosting).toBeNull();
  expect(
    telemetry({
      ...sample,
      hosting: {
        provider: "Hetzner",
        region: "eu-central",
        zone: "hel1-dc2",
        secret: "not persisted",
      },
      providerOverride: "injected",
    }),
  ).toMatchObject({
    hosting: { provider: "Hetzner", region: "eu-central", zone: "hel1-dc2" },
  });
  expect(
    JSON.stringify(
      telemetry({
        ...sample,
        hosting: { provider: "AWS", secret: "not persisted" },
        providerOverride: "injected",
      }),
    ),
  ).not.toMatch(/secret|injected/);
  for (const hosting of [
    "Hetzner",
    [],
    {},
    { provider: "Unknown" },
    { provider: "AWS", region: "x".repeat(101) },
    { provider: "AWS", zone: "zone\r\n" },
    { provider: "AWS", zone: "<script>" },
    { provider: "AWS", region: null },
  ]) {
    expect(() => telemetry({ ...sample, hosting })).toThrow();
  }
});

test("owner override persists across reports and can return to automatic detection", async () => {
  const f = await enrolled();
  const machines = new MachineStore(f.sql);
  const entry = await machines.create("VPS");
  const credential = randomToken();
  await machines.enroll(entry.token, credential);
  await machines.ingest(
    entry.id,
    telemetry({ ...sample, hosting: { provider: "Hetzner" } }),
  );
  const set = (provider: unknown) =>
    f.browser.request("/machines/provider", { id: entry.id, provider });
  expect((await set(" netcup ")).status).toBe(200);
  // A malicious/older/newer agent can never control the separately stored owner override.
  await machines.ingest(
    entry.id,
    telemetry({
      ...sample,
      hosting: { provider: "AWS" },
      providerOverride: "AWS",
    }),
  );
  let row = (await machines.list())[0];
  expect(row?.providerOverride).toBe("netcup");
  expect(row?.telemetry?.hosting?.provider).toBe("AWS");
  expect((await set(null)).status).toBe(200);
  row = (await machines.list())[0];
  expect(row?.providerOverride).toBeNull();
  expect(row?.telemetry?.hosting?.provider).toBe("AWS");
  expect(
    (
      await f.sql.query(
        "SELECT event FROM tenet_auth_audit WHERE event = 'machine.provider_changed'",
      )
    ).length,
  ).toBe(2);
  for (const value of [
    undefined,
    "",
    "  ",
    12,
    [],
    {},
    "a".repeat(61),
    "a\nb",
  ]) {
    expect((await set(value)).status).toBe(400);
  }
  await machines.revoke(entry.id);
  expect((await set("netcup")).status).toBe(404);
});

test("provider editing rejects unauthenticated, agent bearer, cross-origin and missing machines", async () => {
  const f = await enrolled();
  const machines = new MachineStore(f.sql);
  const entry = await machines.create("VPS");
  const credential = randomToken();
  await machines.enroll(entry.token, credential);
  const body = { id: entry.id, provider: "netcup" };
  expect(
    (await new Browser(f.app).request("/machines/provider", body)).status,
  ).toBe(401);
  expect(
    (
      await new Browser(f.app).request("/machines/provider", body, {
        authorization: `Bearer ${credential}`,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.browser.request("/machines/provider", body, {
        origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.browser.request("/machines/provider", { ...body, id: "missing" }))
      .status,
  ).toBe(404);
  expect((await machines.list())[0]?.providerOverride).toBeNull();
});
