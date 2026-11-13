import { expect, test } from "bun:test";
import { primaryAddress } from "../../../apps/dashboard/src/lib/machine-address";
import { telemetry } from "../src/machines/store";

test("prefers public IPv4, then public IPv6, without guessing a public NAT address", () => {
  expect(primaryAddress(["10.0.0.1", "2a01:4f8::1", "88.198.1.2"])).toBe(
    "88.198.1.2",
  );
  expect(primaryAddress(["192.168.1.1", "fe80::1", "2a01:4f8::1"])).toBe(
    "2a01:4f8::1",
  );
  expect(
    primaryAddress([
      "127.0.0.1",
      "10.0.0.1",
      "100.64.1.1",
      "2001:db8::1",
      "::1",
    ]),
  ).toBeUndefined();
  expect(primaryAddress()).toBeUndefined();
});
test("validates reported IPs and remains compatible with older agents", () => {
  const sample = {
    version: 1,
    hostname: "host",
    os: "Linux",
    arch: "x86_64",
    agentVersion: "0",
    cpuCount: 1,
    cpuPercent: 0,
    memoryTotal: 100,
    memoryUsed: 10,
    uptime: 1,
    disks: [],
  };
  expect(telemetry(sample).ipAddresses).toBeUndefined();
  expect(
    telemetry({ ...sample, ipAddresses: ["88.198.1.2", "::1", "88.198.1.2"] })
      .ipAddresses,
  ).toEqual(["88.198.1.2", "::1"]);
  for (const ipAddresses of [
    ["example.com"],
    ["1.2.3.999"],
    ["<script>"],
    Array(65).fill("1.1.1.1"),
    null,
  ])
    expect(() => telemetry({ ...sample, ipAddresses })).toThrow();
});
