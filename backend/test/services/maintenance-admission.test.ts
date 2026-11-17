import { mkdtemp, writeFile, rm, unlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MaintenanceAdmission,
  maintenanceHttpAdmission,
} from "../../src/services/maintenance-admission";

describe("maintenance admission marker", () => {
  it("latches shutdown without a marker and rejects new work while completion and reads remain available", async () => {
    const gate = new MaintenanceAdmission();
    const app = new Hono();
    app.use("*", maintenanceHttpAdmission(gate));
    app.all("*", (c) => c.json({ admitted: true }));
    expect((await app.request("/work", { method: "POST" })).status).toBe(200);
    gate.closeForShutdown();
    gate.closeForShutdown();
    expect(() => gate.assertOpen()).toThrow("MAINTENANCE_DRAINING");
    expect((await app.request("/work", { method: "POST" })).status).toBe(503);
    expect(
      (await app.request("/socket", { headers: { upgrade: "websocket" } }))
        .status,
    ).toBe(503);
    expect((await app.request("/status")).status).toBe(200);
    expect(
      (
        await app.request("/api/internal/schedule-runs/outcome", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
  });
  it("cannot reopen shutdown admission by removing a temporary marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "shutdown-admission-"));
    const marker = join(root, "drain");
    try {
      const gate = new MaintenanceAdmission(marker);
      await writeFile(marker, "draining");
      gate.closeForShutdown();
      await unlink(marker);
      expect(gate.isClosed()).toBe(true);
      expect(() => gate.assertOpen()).toThrow("MAINTENANCE_DRAINING");
    } finally {
      await rm(root, { recursive: true });
    }
  });
  it("stays closed if the configured marker parent disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "admission-parent-"));
    const gate = new MaintenanceAdmission(join(root, "drain"));
    try {
      expect(gate.isClosed()).toBe(false);
      await writeFile(join(root, "drain"), "closed");
      await rename(root, `${root}-moved`);
      expect(gate.isClosed()).toBe(true);
    } finally {
      await rm(`${root}-moved`, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
  it("blocks HTTP mutation and new websocket upgrades while preserving status reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "admission-"));
    const marker = join(root, "drain");
    try {
      const gate = new MaintenanceAdmission(marker);
      const app = new Hono();
      app.use("*", maintenanceHttpAdmission(gate));
      app.all("*", (c) => c.json({ admitted: true }));
      expect((await app.request("/work", { method: "POST" })).status).toBe(200);
      await writeFile(marker, "draining", { mode: 0o600 });
      expect((await app.request("/work", { method: "POST" })).status).toBe(503);
      expect(
        (await app.request("/socket", { headers: { upgrade: "websocket" } }))
          .status,
      ).toBe(503);
      expect((await app.request("/status")).status).toBe(200);
      expect(
        (
          await app.request("/api/internal/schedule-runs/outcome", {
            method: "POST",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request("/api/claude-inference/v1/messages", {
            method: "POST",
          })
        ).status,
      ).toBe(200);
      expect(() => gate.assertOpen()).toThrow("MAINTENANCE_DRAINING");
      await unlink(marker);
      expect((await app.request("/work", { method: "POST" })).status).toBe(200);
    } finally {
      await rm(root, { recursive: true });
    }
  });
  it("does not enable maintenance implicitly", () => {
    expect(new MaintenanceAdmission().isClosed()).toBe(false);
    expect(() => new MaintenanceAdmission("relative")).toThrow(
      "MAINTENANCE_DRAINING",
    );
  });
});
