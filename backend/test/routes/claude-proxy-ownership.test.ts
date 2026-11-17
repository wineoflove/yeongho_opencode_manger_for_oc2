import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createProvidersRoutes } from "../../src/routes/providers";
import { createOAuthRoutes } from "../../src/routes/oauth";
import { createStubOpenCodeClient } from "../helpers/stub-opencode-client";

function fixture(ownsInference: boolean) {
  const client = createStubOpenCodeClient();
  const app = new Hono();
  app.route(
    "/providers",
    createProvidersRoutes(client, undefined, { ownsInference }),
  );
  app.route("/oauth", createOAuthRoutes(client, ownsInference));
  return { app, client };
}

describe("Claude account ownership routing", () => {
  it("reports ownership even when management data is unavailable", async () => {
    const { app } = fixture(true);
    const response = await app.request("/providers/claude-proxy/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: false,
      ownsInference: true,
    });
  });
  it.each([
    ["POST", "/providers/anthropic/credentials"],
    ["DELETE", "/providers/anthropic/credentials"],
    ["PATCH", "/providers/anthropic/accounts/credential-a"],
    ["POST", "/providers/anthropic/accounts/credential-a/activate"],
    ["DELETE", "/providers/anthropic/accounts/credential-a"],
    ["PUT", "/providers/anthropic/pool"],
    ["POST", "/oauth/anthropic/oauth/authorize"],
    ["POST", "/oauth/anthropic/oauth/callback"],
    ["DELETE", "/oauth/anthropic/oauth/attempt-a"],
    ["POST", "/providers/%61nthropic/credentials"],
    ["POST", "/providers/openai/credentials"],
    ["DELETE", "/providers/openai/credentials"],
    ["PATCH", "/providers/openai/accounts/credential-a"],
    ["POST", "/providers/openai/accounts/credential-a/activate"],
    ["DELETE", "/providers/openai/accounts/credential-a"],
    ["PUT", "/providers/openai/pool"],
    ["POST", "/oauth/openai/oauth/authorize"],
    ["POST", "/oauth/openai/oauth/callback"],
    ["DELETE", "/oauth/openai/oauth/attempt-a"],
    ["POST", "/providers/claude-agent/external-login"],
    ["DELETE", "/providers/claude-agent/credentials"],
    ["POST", "/oauth/claude-agent/oauth/authorize"],
  ])(
    "rejects native writes when the proxy owns inference: %s %s",
    async (method, path) => {
      if (!method || !path) throw new Error("invalid_case");
      const { app, client } = fixture(true);
      const response = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        code: "CLAUDE_PROXY_MANAGED",
        error:
          "Claude, OpenAI and Claude Agent accounts are managed by CLIProxyAPI.",
      });
      expect(client.api.integration.oauth.connect).not.toHaveBeenCalled();
      expect(client.api.credential.list).not.toHaveBeenCalled();
    },
  );

  it.each(["anthropic", "openai"])(
    "preserves native credential connection for %s when ownership is off",
    async (provider) => {
      const { app } = fixture(false);
      const response = await app.request(`/providers/${provider}/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey: "test-api-key" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty(
        "code",
        "CLAUDE_PROXY_MANAGED",
      );
    },
  );

  it("does not block another provider even when Claude is proxy-managed", async () => {
    const { app } = fixture(true);
    const response = await app.request("/oauth/google/oauth/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty(
      "code",
      "CLAUDE_PROXY_MANAGED",
    );
  });

  it.each(["anthropic", "openai"])(
    "allows native %s OAuth when ownership is off",
    async (provider) => {
      const { app, client } = fixture(false);
      const response = await app.request(`/oauth/${provider}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ methodID: "oauth" }),
      });
      expect(response.status).toBe(200);
      expect(client.api.integration.oauth.connect).toHaveBeenCalledWith(
        expect.objectContaining({ integrationID: provider }),
      );
    },
  );
});
