import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadClaudeInference } from "../../src/services/claude-inference-config";
import { ClaudeProxyGate } from "../../src/services/claude-proxy-gate";

async function withKeys(
  run: (root: string, files: Record<string, string>) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "proxy-inference-upstream-"));
  try {
    const files = {
      OCM_CLAUDE_INFERENCE_KEY_FILE: join(root, "incoming"),
      OCM_CLAUDE_PROXY_API_KEY_FILE: join(root, "upstream"),
      OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: join(root, "management"),
      OCM_CLAUDE_PROXY_GATE_DIRECTORY: join(root, "gate"),
    };
    await writeFile(
      files.OCM_CLAUDE_INFERENCE_KEY_FILE,
      "test-incoming-secret",
      { mode: 0o600 },
    );
    await writeFile(
      files.OCM_CLAUDE_PROXY_API_KEY_FILE,
      "test-upstream-secret",
      { mode: 0o600 },
    );
    await writeFile(
      files.OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE,
      "test-management-secret",
      { mode: 0o600 },
    );
    await ClaudeProxyGate.initialize(files.OCM_CLAUDE_PROXY_GATE_DIRECTORY);
    await run(root, files);
  } finally {
    await rm(root, { recursive: true });
  }
}

async function withRecorder(
  run: (url: string, hits: string[]) => Promise<void>,
) {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "message", content: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      hits,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("inference opt-in configuration", () => {
  it("does not enable inference merely because management is configured", async () => {
    expect(
      await loadClaudeInference({
        OCM_CLAUDE_PROXY_URL: "http://127.0.0.1:5117",
      }),
    ).toBeUndefined();
  });
  it("rejects incomplete inference configuration", async () => {
    await expect(
      loadClaudeInference({ OCM_CLAUDE_INFERENCE_KEY_FILE: "/private/test" }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIGURATION",
    });
  });
  it.each([true, false])(
    "requires distinct management, upstream and ingress keys: shared=%s",
    async (shared) => {
      const root = await mkdtemp(join(tmpdir(), "proxy-inference-config-"));
      try {
        await writeFile(join(root, "incoming"), "test-incoming-secret", {
          mode: 0o600,
        });
        await writeFile(
          join(root, "upstream"),
          shared ? "test-incoming-secret" : "test-upstream-secret",
          { mode: 0o600 },
        );
        await writeFile(join(root, "management"), "test-management-secret", {
          mode: 0o600,
        });
        const promise = loadClaudeInference({
          OCM_CLAUDE_PROXY_URL: "http://127.0.0.1:5117",
          OCM_CLAUDE_INFERENCE_KEY_FILE: join(root, "incoming"),
          OCM_CLAUDE_PROXY_API_KEY_FILE: join(root, "upstream"),
          OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE: join(root, "management"),
          OCM_CLAUDE_PROXY_GATE_DIRECTORY: join(root, "uninitialized-gate"),
        });
        if (shared)
          await expect(promise).rejects.toMatchObject({
            code: "INVALID_CONFIGURATION",
          });
        else {
          const binding = await promise;
          expect(binding?.key).toBe("test-incoming-secret");
          await expect(
            binding?.transport.messages("{}", new AbortController().signal),
          ).rejects.toMatchObject({
            code: "GATE_UNAVAILABLE",
          });
        }
      } finally {
        await rm(root, { recursive: true });
      }
    },
  );
});

describe("inference upstream selection", () => {
  const body = JSON.stringify({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
  });

  it("sends inference to the management proxy when no separate upstream is configured", async () => {
    await withRecorder(async (proxyUrl, hits) => {
      await withKeys(async (_root, files) => {
        const binding = await loadClaudeInference({
          ...files,
          OCM_CLAUDE_PROXY_URL: proxyUrl,
        });
        await binding?.transport.messages(body, new AbortController().signal);
        expect(hits).toEqual(["/v1/messages"]);
      });
    });
  });

  it("sends inference to the separate upstream while management stays on the proxy", async () => {
    await withRecorder(async (proxyUrl, proxyHits) => {
      await withRecorder(async (upstreamUrl, upstreamHits) => {
        await withKeys(async (_root, files) => {
          const binding = await loadClaudeInference({
            ...files,
            OCM_CLAUDE_PROXY_URL: proxyUrl,
            OCM_CLAUDE_INFERENCE_UPSTREAM_URL: upstreamUrl,
          });
          await binding?.transport.messages(body, new AbortController().signal);
          expect(upstreamHits).toEqual(["/v1/messages"]);
          expect(proxyHits).toEqual([]);
        });
      });
    });
  });

  it.each([
    "http://192.168.1.5:18788",
    "https://127.0.0.1:18788",
    "http://127.0.0.1:18788/v1",
  ])("rejects a non-loopback or non-root upstream %s", async (upstream) => {
    await withKeys(async (_root, files) => {
      await expect(
        loadClaudeInference({
          ...files,
          OCM_CLAUDE_PROXY_URL: "http://127.0.0.1:5117",
          OCM_CLAUDE_INFERENCE_UPSTREAM_URL: upstream,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/^INVALID_(TARGET|CONFIGURATION)$/),
      });
    });
  });

  it("refuses to compress twice when inference already goes through a separate upstream", async () => {
    await withKeys(async (_root, files) => {
      await expect(
        loadClaudeInference({
          ...files,
          OCM_CLAUDE_PROXY_URL: "http://127.0.0.1:5117",
          OCM_CLAUDE_INFERENCE_UPSTREAM_URL: "http://127.0.0.1:18788",
          OCM_CLAUDE_COMPRESSION_URL: "http://127.0.0.1:18787",
        }),
      ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    });
  });
});
