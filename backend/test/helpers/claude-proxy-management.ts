import { Hono } from "hono";
import { vi } from "vitest";
import { ClaudeProxyClient } from "../../src/services/claude-proxy-client";
import { createClaudeProxyRoutes } from "../../src/routes/claude-proxy";

export function proxyFixture() {
  const wire = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", wire);
  const client = new ClaudeProxyClient({
    baseUrl: "http://127.0.0.1:1",
    managementKey: "test-key",
    pollIntervalMs: 1,
    pollTimeoutMs: 10,
  });
  const app = new Hono().route(
    "/api/providers",
    createClaudeProxyRoutes(client),
  );
  return {
    wire,
    app,
    request(path: string, body: unknown, method = "POST") {
      return app.request(`/api/providers/claude-proxy/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
  };
}
