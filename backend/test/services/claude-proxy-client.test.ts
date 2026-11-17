import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { ClaudeProxyClient } from "../../src/services/claude-proxy-client";
import { createClaudeProxyRoutes } from "../../src/routes/claude-proxy";

const account = {
  auth_index: "aa47ac1b75dc0765",
  provider: "claude",
  name: "account.json",
  success: 7,
  failed: 2,
  disabled: false,
  unavailable: false,
};

async function fixture(payload: unknown, status = 200) {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (
      request.headers.authorization !== "Bearer test-management-key" ||
      request.url !== "/v8/management/credentials"
    ) {
      response.writeHead(400).end();
      return;
    }
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test_listener_missing");
  const client = new ClaudeProxyClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    managementKey: "test-management-key",
  });
  return {
    client,
    requests: () => requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("Claude proxy management boundary", () => {
  it("sorts supported providers and labels while preserving availability and counters", async () => {
    const source = await fixture({
      observed_at: "2026-11-16T00:00:00Z",
      files: [
        {
          ...account,
          auth_index: "0000000000000001",
          provider: "codex",
          email: "z@example.test",
          label: "ignored",
        },
        {
          ...account,
          auth_index: "0000000000000002",
          email: "",
          label: "b",
          disabled: true,
        },
        {
          ...account,
          auth_index: "0000000000000003",
          email: "a",
          unavailable: true,
          last_refresh: "2026-11-15T00:00:00Z",
          next_retry_after: "2026-11-17T00:00:00Z",
        },
        { ...account, auth_index: "0000000000000004", provider: "gemini" },
      ],
    });
    try {
      const result = await source.client.listAccounts();
      expect(result.accounts).toEqual([
        {
          id: "0000000000000003",
          provider: "claude",
          label: "a",
          enabled: true,
          available: false,
          successCount: 7,
          failureCount: 2,
          lastRefreshedAt: "2026-11-15T00:00:00Z",
          nextRetryAt: "2026-11-17T00:00:00Z",
        },
        {
          id: "0000000000000002",
          provider: "claude",
          label: "b",
          enabled: false,
          available: false,
          successCount: 7,
          failureCount: 2,
          lastRefreshedAt: null,
          nextRetryAt: null,
        },
        {
          id: "0000000000000001",
          provider: "openai",
          label: "z@example.test",
          enabled: true,
          available: true,
          successCount: 7,
          failureCount: 2,
          lastRefreshedAt: null,
          nextRetryAt: null,
        },
      ]);
    } finally {
      await source.close();
    }
  });
  it("returns only safe Claude and OpenAI metadata through the Manager route", async () => {
    const source = await fixture({
      observed_at: "2026-11-12T05:34:17Z",
      files: [
        {
          ...account,
          source: "secret-client-key",
          access_token: "secret-access-token",
          path: "/private/auth.json",
          status_message: "secret-error",
        },
        { ...account, auth_index: "eed28c2707b1e6a7", provider: "codex" },
      ],
    });
    try {
      const response = await createClaudeProxyRoutes(source.client).request(
        "/claude-proxy/accounts",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        configured: true,
        observedAt: "2026-11-12T05:34:17Z",
        accounts: [
          {
            id: account.auth_index,
            provider: "claude",
            label: null,
            successCount: 7,
            failureCount: 2,
            enabled: true,
            available: true,
            lastRefreshedAt: null,
            nextRetryAt: null,
          },
          {
            id: "eed28c2707b1e6a7",
            provider: "openai",
            label: null,
            successCount: 7,
            failureCount: 2,
            enabled: true,
            available: true,
            lastRefreshedAt: null,
            nextRetryAt: null,
          },
        ],
      });
    } finally {
      await source.close();
    }
  });

  it.each([401, 403, 429, 503])(
    "does not retry or return the upstream body on HTTP %i",
    async (status) => {
      const source = await fixture({ error: "private-response-body" }, status);
      try {
        const response = await createClaudeProxyRoutes(source.client).request(
          "/claude-proxy/accounts",
        );
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
          code:
            status === 401 || status === 403 ? "ACCESS_DENIED" : "UNAVAILABLE",
        });
        expect(source.requests()).toBe(1);
      } finally {
        await source.close();
      }
    },
  );

  it.each([
    { files: [account], has_more: true, code: "PARTIAL_RESPONSE" },
    { files: [account, account], code: "INVALID_RESPONSE" },
    {
      files: [{ ...account, auth_index: "secret-not-an-index" }],
      code: "INVALID_RESPONSE",
    },
  ])(
    "rejects incomplete or ambiguous inventory: $code",
    async ({ files, has_more, code }) => {
      const source = await fixture({
        observed_at: "2026-11-12T05:34:17Z",
        files,
        has_more,
      });
      try {
        await expect(source.client.listAccounts()).rejects.toMatchObject({
          code,
        });
      } finally {
        await source.close();
      }
    },
  );

  it("keeps proxy mode disabled until a client is explicitly configured", async () => {
    const response = await createClaudeProxyRoutes().request(
      "/claude-proxy/accounts",
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      configured: false,
      code: "CLAUDE_PROXY_NOT_CONFIGURED",
    });
  });

  it.each([
    "https://external.invalid",
    "http://127.0.0.1/other",
    "http://user:password@127.0.0.1",
  ])("rejects management endpoint %s", (baseUrl) => {
    expect(
      () =>
        new ClaudeProxyClient({
          baseUrl,
          managementKey: "test-management-key",
        }),
    ).toThrow("INVALID_ENDPOINT");
  });
});
