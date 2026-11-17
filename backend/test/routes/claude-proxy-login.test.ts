import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyFixture } from "../helpers/claude-proxy-management";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("proxy OAuth at the HTTP boundary", () => {
  it.each(["claude", "openai"] as const)(
    "starts %s login with a validated authorization URL",
    async (provider) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-16T00:00:00Z"));
      const { request, wire } = proxyFixture();
      const host = provider === "claude" ? "claude.ai" : "auth.openai.com";
      wire.mockResolvedValue(
        Response.json({
          status: "ok",
          state: "pending-state",
          url: `https://${host}/authorize`,
        }),
      );
      const response = await request("logins", { provider });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        provider,
        state: "pending-state",
        url: `https://${host}/authorize`,
        expiresAt: "2026-11-16T00:05:00.000Z",
      });
      expect(wire).toHaveBeenCalledWith(
        new URL(
          `http://127.0.0.1:1/v0/management/${provider === "claude" ? "anthropic" : "codex"}-auth-url`,
        ),
        expect.objectContaining({
          redirect: "error",
          headers: expect.objectContaining({
            authorization: "Bearer test-key",
          }),
          signal: expect.any(AbortSignal),
        }),
      );
    },
  );

  it.each([
    "http://claude.ai/auth",
    "https://claude.ai.evil.test/auth",
    "https://auth.openai.com/auth",
    "broken",
  ])("rejects an unsafe Claude authorization URL: %s", async (url) => {
    const { request, wire } = proxyFixture();
    wire.mockResolvedValue(Response.json({ status: "ok", state: "s", url }));
    const response = await request("logins", { provider: "claude" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "INVALID_RESPONSE" });
  });

  it.each(["claude", "openai"] as const)(
    "completes %s login and polls until saved",
    async (provider) => {
      vi.useFakeTimers();
      const { request, wire } = proxyFixture();
      wire
        .mockResolvedValueOnce(Response.json({ status: "ok" }))
        .mockResolvedValueOnce(Response.json({ status: "wait" }))
        .mockResolvedValueOnce(Response.json({ status: "ok" }));
      const path = provider === "claude" ? "/callback" : "/auth/callback";
      const pending = request("logins/complete", {
        provider,
        state: "s",
        redirectUrl: `http://localhost:1455${path}?state=s&code=abc${provider === "claude" ? "%23fragment" : ""}`,
      });
      await vi.advanceTimersByTimeAsync(2);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
      expect(wire).toHaveBeenNthCalledWith(
        1,
        new URL("http://127.0.0.1:1/v0/management/oauth-callback"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            provider: provider === "claude" ? "anthropic" : "codex",
            state: "s",
            code: "abc",
          }),
        }),
      );
      expect(wire).toHaveBeenNthCalledWith(
        3,
        new URL("http://127.0.0.1:1/v0/management/get-auth-status?state=s"),
        expect.anything(),
      );
    },
  );

  it.each([
    ["https://localhost/callback?state=s&code=a", "INVALID_REDIRECT"],
    ["http://evil.test/callback?state=s&code=a", "INVALID_REDIRECT"],
    ["http://localhost/auth/callback?state=s&code=a", "INVALID_REDIRECT"],
    ["http://localhost/callback?state=wrong&code=a", "INVALID_REDIRECT"],
    ["http://localhost/callback?state=s", "INVALID_REDIRECT"],
    ["http://localhost/callback?state=s&code=%23fragment", "INVALID_REDIRECT"],
    ["not-a-url", "INVALID_REDIRECT"],
    ["http://localhost/callback?error=access_denied&state=s", "LOGIN_DENIED"],
  ])("rejects invalid callback %s", async (redirectUrl, code) => {
    const { request, wire } = proxyFixture();
    const response = await request("logins/complete", {
      provider: "claude",
      state: "s",
      redirectUrl,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code });
    expect(wire).not.toHaveBeenCalled();
  });

  it.each([404, 409])(
    "maps expired callback HTTP %i to LOGIN_EXPIRED",
    async (status) => {
      const { request, wire } = proxyFixture();
      wire.mockResolvedValue(Response.json({ error: "private" }, { status }));
      const response = await request("logins/complete", {
        provider: "openai",
        state: "s",
        redirectUrl: "http://127.0.0.1/auth/callback?state=s&code=a",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "LOGIN_EXPIRED" });
      expect(wire).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["error", "wait"])(
    "maps poll status %s without leaking upstream errors",
    async (status) => {
      vi.useFakeTimers();
      const { request, wire } = proxyFixture();
      wire
        .mockResolvedValueOnce(Response.json({ status: "ok" }))
        .mockImplementation(async () =>
          Response.json({ status, error: "private" }),
        );
      const pending = request("logins/complete", {
        provider: "openai",
        state: "s",
        redirectUrl: "http://127.0.0.1/auth/callback?state=s&code=a",
      });
      await vi.advanceTimersByTimeAsync(11);
      const response = await pending;
      expect(response.status).toBe(status === "error" ? 502 : 504);
      expect(await response.json()).toEqual({
        code: status === "error" ? "LOGIN_FAILED" : "LOGIN_PENDING",
      });
    },
  );
});
