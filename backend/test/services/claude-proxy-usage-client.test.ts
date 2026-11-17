import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { ClaudeProxyClient } from "../../src/services/claude-proxy-client";

type Route = { readonly status?: number; readonly body: unknown };

async function fixture(routes: Record<string, Route>) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? "");
    const route = routes[request.url ?? ""];
    if (
      request.headers.authorization !== "Bearer test-management-key" ||
      !route
    ) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(route.status ?? 200, { "content-type": "application/json" })
      .end(JSON.stringify(route.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test_listener_missing");
  return {
    seen,
    client: new ClaudeProxyClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      managementKey: "test-management-key",
    }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const credential = {
  auth_index: "aa47ac1b75dc0765",
  provider: "claude",
  name: "claude-user.json",
  email: "user@example.test",
  account: "synthetic-raw-account-must-never-leave",
  account_type: "oauth",
  disabled: false,
  unavailable: false,
  success: 3,
  failed: 1,
  quota_blocked: false,
  renewal_state: "renewal_verified",
  quota: {
    observed_at: "2026-11-17T01:00:00Z",
    signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1794890000",
    },
  },
  cooldowns: [
    {
      scope: "model",
      model_key: "claude-opus-5-5",
      reason: "quota",
      retry_at: "2026-11-17T02:00:00Z",
      remaining_seconds: 120,
      http_status: 429,
    },
  ],
  recent_requests: [{ time: "09:00-09:10", success: 2, failed: 0 }],
};

const record = {
  timestamp: "2026-11-17T01:02:03.456Z",
  auth_index: "aa47ac1b75dc0765",
  provider: "claude",
  executor_type: "claude",
  model: "claude-opus-5-5",
  alias: "claude-opus-5-5",
  response_model: "claude-opus-5-5",
  request_id: "req-1",
  execution_id: "exec-1",
  session_id: "1f0c3c1e-7a49-4cb8-9a52-111111111111",
  failed: false,
  fail: { status_code: 200, body: "private-upstream-body" },
  stream: true,
  latency_ms: 812,
  accounting_version: 2,
  api_key: "test-client-key",
  source: "private-source",
  access_token_sha256: "a".repeat(64),
  client_ip: "127.0.0.1",
  user_agent: "private-agent",
  response_headers: { "Set-Cookie": ["private-cookie"] },
  tokens: {
    input_tokens: 10,
    output_tokens: 4,
    reasoning_tokens: 1,
    cached_tokens: 0,
    cache_read_tokens: 6,
    cache_creation_tokens: 2,
    total_tokens: 22,
  },
  token_breakdown: {
    schema_version: 2,
    quality: "complete",
    total_tokens: 22,
    input: {
      total_tokens: 18,
      uncached_tokens: 10,
      cache_read_tokens: 6,
      cache_write_tokens: 2,
    },
    output: { total_tokens: 4, non_reasoning_tokens: 3, reasoning_tokens: 1 },
    unclassified_tokens: 0,
  },
};

describe("CLIProxy usage contracts", () => {
  it("exposes quota sources without the raw account field", async () => {
    const source = await fixture({
      "/v8/management/credentials": {
        body: {
          observed_at: "2026-11-17T01:05:00Z",
          files: [
            credential,
            {
              ...credential,
              auth_index: "ffffffffffffffff",
              provider: "gemini",
            },
          ],
        },
      },
    });
    try {
      const result = await source.client.listAccountUsageSources();
      expect(result.observedAt).toBe("2026-11-17T01:05:00Z");
      expect(result.accounts).toEqual([
        {
          id: "aa47ac1b75dc0765",
          provider: "claude",
          label: "user@example.test",
          accountType: "oauth",
          enabled: true,
          unavailable: false,
          quotaBlocked: false,
          renewalState: "renewal_verified",
          successCount: 3,
          failureCount: 1,
          nextRetryAt: null,
          quota: {
            observedAt: "2026-11-17T01:00:00Z",
            signals: {
              "Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
              "Anthropic-Ratelimit-Unified-5h-Reset": "1794890000",
            },
          },
          cooldowns: [
            {
              scope: "model",
              modelKey: "claude-opus-5-5",
              reason: "quota",
              retryAt: "2026-11-17T02:00:00Z",
              remainingSeconds: 120,
              httpStatus: 429,
            },
          ],
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("synthetic-raw-account");
    } finally {
      await source.close();
    }
  });

  it("treats a missing quota observation as unobserved", async () => {
    const bare = Object.fromEntries(
      Object.entries(credential).filter(
        ([key]) => key !== "quota" && key !== "cooldowns",
      ),
    );
    const source = await fixture({
      "/v8/management/credentials": {
        body: { observed_at: "2026-11-17T01:05:00Z", files: [bare] },
      },
    });
    try {
      const [account] = (await source.client.listAccountUsageSources())
        .accounts;
      expect(account?.quota).toEqual({ observedAt: null, signals: {} });
      expect(account?.cooldowns).toEqual([]);
    } finally {
      await source.close();
    }
  });

  it("pops usage records through an allowlist", async () => {
    const source = await fixture({
      "/v8/management/observability/usage/queue?count=200": {
        body: [
          record,
          {
            ...record,
            execution_id: "exec-2",
            failed: true,
            fail: { status_code: 429, body: "private" },
          },
          { provider: "claude" },
        ],
      },
    });
    try {
      const page = await source.client.popUsageQueue(200);
      expect(page.received).toBe(3);
      expect(page.rejected).toBe(1);
      expect(page.records[0]).toEqual({
        occurredAt: "2026-11-17T01:02:03.456Z",
        authIndex: "aa47ac1b75dc0765",
        provider: "claude",
        executorType: "claude",
        model: "claude-opus-5-5",
        alias: "claude-opus-5-5",
        responseModel: "claude-opus-5-5",
        requestId: "req-1",
        executionId: "exec-1",
        sessionId: "1f0c3c1e-7a49-4cb8-9a52-111111111111",
        failed: false,
        failureStatus: null,
        stream: true,
        latencyMs: 812,
        accountingVersion: 2,
        tokens: {
          input: 10,
          output: 4,
          reasoning: 1,
          cached: 0,
          cacheRead: 6,
          cacheCreation: 2,
          total: 22,
        },
        breakdown: {
          quality: "complete",
          total: 22,
          input: { total: 18, uncached: 10, cacheRead: 6, cacheWrite: 2 },
          output: { total: 4, nonReasoning: 3, reasoning: 1 },
          unclassified: 0,
        },
      });
      expect(page.records[1]?.failureStatus).toBe(429);
      const serialized = JSON.stringify(page);
      for (const forbidden of [
        "test-client-key",
        "private-source",
        "private-upstream-body",
        "private-agent",
        "private-cookie",
        "a".repeat(64),
      ])
        expect(serialized).not.toContain(forbidden);
    } finally {
      await source.close();
    }
  });

  it.each([
    [{ body: { records: [] } }, "INVALID_RESPONSE"],
    [{ status: 401, body: {} }, "ACCESS_DENIED"],
  ])("rejects an unusable queue response %#", async (route, code) => {
    const source = await fixture({
      "/v8/management/observability/usage/queue?count=50": route,
    });
    try {
      await expect(source.client.popUsageQueue(50)).rejects.toMatchObject({
        code,
      });
    } finally {
      await source.close();
    }
  });
});
