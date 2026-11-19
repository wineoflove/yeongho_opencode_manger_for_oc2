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
  it('allows tracked inference followups during enter but closes them atomically on seal', () => {
    const gate = new MaintenanceAdmission()
    gate.enter('owner')
    const release = gate.admitInference()
    expect(gate.status().pendingHandlers).toBe(1)
    expect(gate.seal('other')).toBe(false)
    expect(gate.seal('owner')).toBe(true)
    expect(() => gate.admitInference()).toThrow('MAINTENANCE_DRAINING')
    release()
    expect(gate.status().pendingHandlers).toBe(0)
    gate.exit('owner')
    gate.admitInference()()
  })

  it('cannot reopen a marker-backed closure by exiting its controlled owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'marker-owned-'))
    try {
      const gate = new MaintenanceAdmission(join(root, 'marker'))
      await writeFile(join(root, 'marker'), 'closed')
      gate.enter('owner')
      expect(gate.exit('owner')).toBe(true)
      expect(gate.status()).toMatchObject({ closed: true, sealed: true })
      expect(() => gate.admitInference()).toThrow('MAINTENANCE_DRAINING')
    } finally { await rm(root, { recursive: true }) }
  })
  it('releases handler tokens exactly once and cannot undo shutdown', () => {
    const gate = new MaintenanceAdmission()
    const release = gate.admit()
    gate.enter('owner')
    expect(gate.status().pendingHandlers).toBe(1)
    release()
    release()
    expect(gate.status().pendingHandlers).toBe(0)
    gate.closeForShutdown()
    expect(gate.exit('owner')).toBe(true)
    expect(gate.isClosed()).toBe(true)
  })

  it.each(['exception', 'timeout'])('releases a handler after %s settles', async (failure) => {
    const gate = new MaintenanceAdmission()
    const app = new Hono()
    app.use('*', maintenanceHttpAdmission(gate))
    app.onError((_error, c) => c.json({ failed: true }, 500))
    app.post('/work', async () => {
      expect(gate.status().pendingHandlers).toBe(1)
      if (failure === 'timeout') await new Promise((resolve) => setTimeout(resolve, 1))
      throw new Error(failure)
    })
    expect((await app.request('/work', { method: 'POST' })).status).toBe(500)
    expect(gate.status().pendingHandlers).toBe(0)
  })

  it('does not count GET/SSE or completion handlers, even while closed', async () => {
    const gate = new MaintenanceAdmission()
    const app = new Hono()
    app.use('*', maintenanceHttpAdmission(gate))
    app.all('*', (c) => {
      expect(gate.status().pendingHandlers).toBe(0)
      return c.body('data: ok\n\n', 200, { 'content-type': 'text/event-stream' })
    })
    gate.enter('owner')
    for (const path of ['/events', '/api/internal/maintenance/status'])
      expect((await app.request(path)).status).toBe(200)
    for (const path of ['/api/internal/schedule-runs/outcome'])
      expect((await app.request(path, { method: 'POST' })).status).toBe(200)
    expect((await app.request('/socket', { headers: { upgrade: 'websocket' } })).status).toBe(503)
  })

  it('counts an admitted websocket upgrade only until its handler returns', async () => {
    const gate = new MaintenanceAdmission()
    const app = new Hono()
    app.use('*', maintenanceHttpAdmission(gate))
    app.get('/socket', (c) => {
      expect(gate.status().pendingHandlers).toBe(1)
      gate.enter('owner')
      return c.json({ upgraded: true })
    })
    expect((await app.request('/socket', { headers: { upgrade: 'websocket' } })).status).toBe(200)
    expect(gate.status().pendingHandlers).toBe(0)
    expect((await app.request('/socket', { headers: { upgrade: 'websocket' } })).status).toBe(503)
  })

  it('does not treat an aborted request as drained until its admitted handler has settled', async () => {
    const gate = new MaintenanceAdmission()
    const app = new Hono()
    const controller = new AbortController()
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const waiting = new Promise<void>((resolve) => { finish = resolve })
    app.use('*', maintenanceHttpAdmission(gate))
    app.post('/work', async (c) => { started(); await waiting; return c.json({ ok: true }) })
    const pending = app.request('/work', { method: 'POST', signal: controller.signal })
    await entered
    gate.enter('owner')
    controller.abort()
    expect(gate.status().pendingHandlers).toBe(1)
    finish()
    await pending
    expect(gate.status().pendingHandlers).toBe(0)
  })
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
      ).toBe(503);
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
