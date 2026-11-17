import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountUsageResponseSchema } from "@opencode-manager/shared/schemas";
import { createClaudeProxyRoutes } from "../../src/routes/claude-proxy";
import { proxyFixture } from "../helpers/claude-proxy-management";

afterEach(() => vi.unstubAllGlobals());

const inventory = {
  observed_at: "2026-11-17T02:00:00Z",
  files: [
    {
      auth_index: "aa47ac1b75dc0765",
      provider: "claude",
      name: "claude.json",
      email: "user@example.test",
      account: "synthetic-raw-account-must-never-leave",
      disabled: false,
      unavailable: false,
      success: 1,
      failed: 0,
      quota: {
        observed_at: "2026-11-17T02:00:00Z",
        signals: { "Anthropic-Ratelimit-Unified-5h-Utilization": "0.5" },
      },
    },
    {
      auth_index: "bb47ac1b75dc0765",
      provider: "codex",
      name: "codex.json",
      disabled: false,
      unavailable: false,
      success: 0,
      failed: 0,
    },
  ],
};

describe("per-account usage endpoint", () => {
  it("returns schema-valid usage for every Claude and OpenAI account", async () => {
    const { request, wire } = proxyFixture();
    wire.mockResolvedValueOnce(Response.json(inventory));
    const response = await request("usage", undefined, "GET");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("synthetic-raw-account");
    const body = AccountUsageResponseSchema.parse(JSON.parse(text));
    expect(
      body.sources.map((source) => [
        source.provider,
        source.accounts.map((account) => account.accountKey),
      ]),
    ).toEqual([
      ["anthropic", ["aa47ac1b75dc0765"]],
      ["openai", ["bb47ac1b75dc0765"]],
    ]);
    expect(body.sources[0]?.accounts[0]?.windows[0]?.usedPercent).toBe(50);
    expect(body.sources[1]?.accounts[0]?.state).toBe("awaiting-first-request");
  });

  it("reports an unconfigured proxy", async () => {
    const app = new Hono().route("/api/providers", createClaudeProxyRoutes());
    const response = await app.request("/api/providers/claude-proxy/usage");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "CLAUDE_PROXY_UNCONFIGURED",
    });
  });

  it("hides upstream failure detail", async () => {
    const { request, wire } = proxyFixture();
    wire.mockResolvedValueOnce(new Response("private-detail", { status: 500 }));
    const response = await request("usage", undefined, "GET");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "UNAVAILABLE" });
  });
});
