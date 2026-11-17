import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeProxyRoutes } from "../../src/routes/claude-proxy";
import { proxyFixture } from "../helpers/claude-proxy-management";

const id = "0123456789abcdef";
const inventory = {
  observed_at: "2026-11-16T00:00:00Z",
  files: [
    {
      auth_index: id,
      provider: "codex",
      name: "a & b.json",
      disabled: false,
      unavailable: false,
      success: 3,
      failed: 1,
    },
  ],
};
afterEach(() => vi.unstubAllGlobals());

describe("proxy account mutations at the HTTP boundary", () => {
  it.each([true, false])(
    "updates enabled=%s using the resolved filename and index",
    async (enabled) => {
      const { request, wire } = proxyFixture();
      wire
        .mockResolvedValueOnce(Response.json(inventory))
        .mockResolvedValueOnce(Response.json({ status: "ok" }));
      const response = await request(`accounts/${id}`, { enabled }, "PATCH");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
      expect(wire).toHaveBeenLastCalledWith(
        new URL("http://127.0.0.1:1/v0/management/auth-files/status"),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            name: "a & b.json",
            auth_index: id,
            disabled: !enabled,
          }),
        }),
      );
    },
  );

  it("deletes only the resolved name using an encoded query", async () => {
    const { request, wire } = proxyFixture();
    wire
      .mockResolvedValueOnce(Response.json(inventory))
      .mockResolvedValueOnce(Response.json({ status: "ok" }));
    const response = await request(`accounts/${id}`, {}, "DELETE");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(wire).toHaveBeenLastCalledWith(
      new URL("http://127.0.0.1:1/v0/management/auth-files?name=a+%26+b.json"),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it.each(["PATCH", "DELETE"])(
    "rejects unsupported accounts for %s",
    async (method) => {
      const { request, wire } = proxyFixture();
      wire.mockResolvedValue(
        Response.json({
          ...inventory,
          files: inventory.files.map((file) => ({
            ...file,
            provider: "gemini",
          })),
        }),
      );
      const response = await request(
        `accounts/${id}`,
        { enabled: true },
        method,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "ACCOUNT_NOT_FOUND" });
      expect(wire).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["logins", { provider: "gemini" }, "POST"],
    ["logins/complete", { provider: "openai" }, "POST"],
    [`accounts/${id}`, { enabled: "true" }, "PATCH"],
    ["accounts/not-an-id", { enabled: true }, "PATCH"],
    ["accounts/ABCDEF0123456789", {}, "DELETE"],
  ] as const)(
    "validates %s before upstream access",
    async (path, body, method) => {
      const { request, wire } = proxyFixture();
      const response = await request(path, body, method);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
      expect(wire).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 500])(
    "sanitizes mutation failure HTTP %i",
    async (status) => {
      const { request, wire } = proxyFixture();
      wire.mockResolvedValue(Response.json({ error: "private" }, { status }));
      const response = await request("logins", { provider: "openai" });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        code: status === 500 ? "UNAVAILABLE" : "ACCESS_DENIED",
      });
      expect(wire).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes network failures without retry", async () => {
    const { request, wire } = proxyFixture();
    wire.mockRejectedValue(new TypeError("private upstream URL"));
    const response = await request("logins", { provider: "openai" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "UNAVAILABLE" });
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["logins", "POST"],
    ["logins/complete", "POST"],
    [`accounts/${id}`, "PATCH"],
    [`accounts/${id}`, "DELETE"],
  ] as const)("fails closed without a client: %s", async (path, method) => {
    const response = await createClaudeProxyRoutes().request(
      `/claude-proxy/${path}`,
      { method },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "CLAUDE_PROXY_NOT_CONFIGURED",
    });
  });
});
