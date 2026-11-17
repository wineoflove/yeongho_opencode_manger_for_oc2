import { beforeEach, expect, it, vi } from "vitest";
import {
  MaintenanceLaunchd,
  type MaintenanceLaunchdCheckpoint,
  type MaintenanceLaunchdUnit,
} from "../../src/services/claude-maintenance-launchd";

const state = vi.hoisted(() => ({
  registered: false,
  pid: 1234,
  started: "initial-start",
  definition: "/fixture/snapshot.plist",
  bootouts: 0,
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn((_file: string, args: string[]) => {
    if (args[0] === "bootout") {
      state.bootouts++;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.includes("-t"))
      return { status: 0, stdout: String(state.pid), stderr: "" };
    if (args[0] === "bootstrap") {
      state.registered = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "print")
      return state.registered
        ? {
            status: 0,
            stdout: `path = ${state.definition}\npid = ${state.pid}\n`,
            stderr: "",
          }
        : {
            status: 113,
            stdout: "",
            stderr: `Could not find service "com.aion.ocm.claude-proxy" in domain for user gui: ${process.getuid?.()}`,
          };
    return { status: 1, stdout: "", stderr: "" };
  }),
}));
vi.mock("../../src/services/claude-transfer-quiescence", () => ({
  captureClaudeProcessTree: (pid: number) => [pid],
  captureProcessIdentities: () => [{ pid: state.pid, started: state.started }],
  listenerProcessIDs: () => [state.pid],
  assertClaudeTransferStopped: vi.fn(),
  assertOwnedRuntimeStopped: vi.fn(),
  survivingIdentities: vi.fn(),
}));
vi.mock("../../src/services/claude-launchd-definition", async (original) => ({
  ...(await original<
    typeof import("../../src/services/claude-launchd-definition")
  >()),
  assertLaunchdDefinition: async () => {},
  snapshotLaunchdDefinition: async () => ({
    path: state.definition,
    sha256: "a".repeat(64),
  }),
}));

beforeEach(() => {
  state.registered = false;
  state.pid = 1234;
  state.started = "initial-start";
  state.bootouts = 0;
});

function fixture() {
  const records: MaintenanceLaunchdCheckpoint[] = [];
  const lifecycle = new MaintenanceLaunchd({
    domain: `gui/${process.getuid?.()}`,
    home: "/fixture",
    stateDirectory: "/fixture",
    claudeProxy: true,
    persist: async (record) => {
      records.push(record);
    },
  });
  const unit: MaintenanceLaunchdUnit = {
    label: "com.aion.ocm.claude-proxy",
    port: 5117,
    registered: false,
    pids: [],
  };
  return { records, lifecycle, unit };
}

it.each(["pid", "start-time"])(
  "rejects replacement by %s without publishing an observed checkpoint",
  async (change) => {
    const { records, lifecycle, unit } = fixture();
    await lifecycle.boot(unit, "/fixture/source.plist", async () => true);
    const readyCount = records.length;
    if (change === "pid") state.pid = 5678;
    else state.started = "replacement-start";
    await expect(lifecycle.assertRunning(unit)).rejects.toMatchObject({
      code: "IDENTITY_CHANGED",
    });
    expect(records).toHaveLength(readyCount);
    expect(unit.pids).toEqual([1234]);
  },
);

it("rejects replacement during the readiness health check", async () => {
  const { records, lifecycle, unit } = fixture();
  await expect(
    lifecycle.boot(unit, "/fixture/source.plist", async () => {
      state.pid = 5678;
      return true;
    }),
  ).rejects.toMatchObject({ code: "IDENTITY_CHANGED" });
  expect(records.some((record) => record.phase === "ready")).toBe(false);
});

it("keeps polling while the started service is not yet accepting connections", async () => {
  const { records, lifecycle, unit } = fixture();
  let attempts = 0;
  await lifecycle.boot(unit, "/fixture/source.plist", async () => {
    attempts++;
    if (attempts === 1) throw new TypeError("fetch failed");
    return true;
  });
  expect(attempts).toBe(2);
  expect(records.at(-1)?.phase).toBe("ready");
});

it("preserves the original process anchor through a successful postflight observation", async () => {
  const { records, lifecycle, unit } = fixture();
  await lifecycle.boot(unit, "/fixture/source.plist", async () => true);
  await lifecycle.assertRunning(unit);
  expect(records.at(-1)).toMatchObject({
    phase: "observed",
    unit: { expectedPID: 1234, expectedStarted: "initial-start" },
  });
});

it("anchors an adopted service before checkpointing and rejects PID reuse", async () => {
  const { records, lifecycle } = fixture();
  state.registered = true;
  const unit = await lifecycle.observeExisting(
    { label: "com.aion.ocm.claude-proxy", port: 5117 },
    {
      definition: state.definition,
      sha256: "a".repeat(64),
      pid: 1234,
    },
  );
  expect(records.at(-1)).toMatchObject({
    phase: "observed-existing",
    unit: { expectedStarted: "initial-start" },
  });
  state.started = "replacement-start";
  await expect(lifecycle.assertRunning(unit)).rejects.toMatchObject({
    code: "IDENTITY_CHANGED",
  });
  expect(records).toHaveLength(1);
});

it.each(["pid", "start-time"])(
  "refuses recovery stop of a replacement %s without issuing bootout",
  async (change) => {
    const { records, lifecycle, unit } = fixture();
    await lifecycle.boot(unit, "/fixture/source.plist", async () => true);
    const readyCount = records.length;
    if (change === "pid") state.pid = 5678;
    else state.started = "replacement-start";
    await expect(lifecycle.recovery().stop(unit)).rejects.toMatchObject({
      code: "IDENTITY_CHANGED",
    });
    expect(state.bootouts).toBe(0);
    expect(records).toHaveLength(readyCount);
    expect(unit.registered).toBe(true);
  },
);
