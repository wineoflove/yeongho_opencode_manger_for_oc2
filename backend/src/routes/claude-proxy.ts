import { Hono } from "hono";
import { z } from "zod";
import {
  ClaudeProxyError,
  type ClaudeProxyClient,
} from "../services/claude-proxy-client";
import {
  proxyAccountIdSchema,
  proxyCallbackCode,
  proxyCompleteSchema,
  proxyEnabledSchema,
  proxyLoginSchema,
} from "../services/claude-proxy-contract";
import { toAccountUsageResponse } from "../services/cliproxy-account-usage";

export function createClaudeProxyRoutes(
  client?: ClaudeProxyClient,
  ownsInference = false,
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ClaudeProxyError)
      return c.json({ code: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ code: "INVALID_REQUEST" }, 400);
    return c.json({ code: "UNAVAILABLE" }, 502);
  });
  app.get("/claude-proxy/status", (c) =>
    c.json({ configured: Boolean(client), ownsInference }),
  );
  app.get("/claude-proxy/accounts", async (c) => {
    if (!client)
      return c.json(
        { configured: false, code: "CLAUDE_PROXY_NOT_CONFIGURED" },
        503,
      );
    return c.json({ configured: true, ...(await client.listAccounts()) });
  });
  app.get("/claude-proxy/usage", async (c) => {
    if (!client) return c.json({ code: "CLAUDE_PROXY_UNCONFIGURED" }, 404);
    return c.json(
      toAccountUsageResponse(
        await client.listAccountUsageSources(),
        Date.now(),
      ),
    );
  });
  app.post("/claude-proxy/logins", async (c) => {
    if (!client) return c.json({ code: "CLAUDE_PROXY_NOT_CONFIGURED" }, 503);
    const body = proxyLoginSchema.parse(await c.req.json());
    return c.json(await client.startLogin(body.provider));
  });
  app.post("/claude-proxy/logins/complete", async (c) => {
    if (!client) return c.json({ code: "CLAUDE_PROXY_NOT_CONFIGURED" }, 503);
    const body = proxyCompleteSchema.parse(await c.req.json());
    const code = proxyCallbackCode(body);
    await client.completeLogin({
      provider: body.provider,
      state: body.state,
      code,
    });
    return c.json({ status: "ok" });
  });
  app.patch("/claude-proxy/accounts/:id", async (c) => {
    if (!client) return c.json({ code: "CLAUDE_PROXY_NOT_CONFIGURED" }, 503);
    const id = proxyAccountIdSchema.parse(c.req.param("id"));
    const body = proxyEnabledSchema.parse(await c.req.json());
    await client.setAccountEnabled(id, body.enabled);
    return c.json({ status: "ok" });
  });
  app.delete("/claude-proxy/accounts/:id", async (c) => {
    if (!client) return c.json({ code: "CLAUDE_PROXY_NOT_CONFIGURED" }, 503);
    const id = proxyAccountIdSchema.parse(c.req.param("id"));
    await client.deleteAccount(id);
    return c.json({ status: "ok" });
  });
  return app;
}
