import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { buildOpenCodeBasicAuth } from "@opencode-manager/shared/opencode";
import { FetchOpenCodeClient } from "../../src/services/opencode/client";
import * as upstream from "../../src/services/opencode/upstream";
import { sseAggregator } from "../../src/services/sse-aggregator";
import {
  createOpenCodeServeDirectories,
  resolveOpenCode2Binary,
  startOpenCodeServe,
} from "../helpers/opencode-binary";
import type { OpenCodeServe } from "../helpers/opencode-binary";

const binary = resolveOpenCode2Binary();
const CHILD_MARKER = "CHILD TASK:";
const CHILD_DONE = "Child done.";
const message = z.object({ role: z.string(), content: z.unknown() });
const toolResult = z.object({
  error: z.object({ type: z.string() }).optional(),
});
const permissionEnvelope = z.object({
  payload: z.object({
    type: z.literal("permission.asked"),
    data: z.object({
      id: z.string(),
      sessionID: z.string(),
      action: z.string(),
    }),
  }),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
      : "";

describe.skipIf(binary === null)(
  "background subagent recovery across an OpenCode kill",
  () => {
    it("resumes the same background child after a forced kill, surfaces its pending approval, and delivers its result to the parent", async () => {
      const directories = await createOpenCodeServeDirectories();
      const directory = join(directories.root, "repo");
      const marker = join(directory, "child-approved.txt");
      const command = `printf 'approved\\n' >> "${marker}"`;
      let requests = 0;
      let childRequests = 0;
      const llm = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests++;
          const body = parseJson(Buffer.concat(chunks).toString("utf8")) as {
            messages?: unknown[];
            tools?: unknown[];
          };
          const messages =
            z.array(message).safeParse(body?.messages ?? []).data ?? [];
          if (!Array.isArray(body?.tools) || requests > 40) {
            response.writeHead(400).end("unexpected request");
            return;
          }
          const child = messages.some(
            (entry) =>
              entry.role === "user" &&
              textOf(entry.content).includes(CHILD_MARKER),
          );
          const last = messages.at(-1);
          const result =
            last?.role === "tool" && typeof last.content === "string"
              ? toolResult.safeParse(parseJson(last.content))
              : null;
          const aborted =
            result?.success === true && result.data.error?.type === "aborted";
          let delta: Record<string, unknown>;
          if (child) {
            childRequests++;
            delta =
              last?.role === "tool" && !aborted
                ? { role: "assistant", content: CHILD_DONE }
                : {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_c${requests}`,
                        type: "function",
                        function: {
                          name: "shell",
                          arguments: JSON.stringify({ command }),
                        },
                      },
                    ],
                  };
          } else if (
            messages.some(
              (entry) =>
                entry.role !== "assistant" &&
                textOf(entry.content).includes(CHILD_DONE),
            )
          ) {
            delta = { role: "assistant", content: "Parent saw child done." };
          } else if (last?.role === "tool") {
            delta = { role: "assistant", content: "Waiting for the child." };
          } else {
            delta = {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: `call_p${requests}`,
                  type: "function",
                  function: {
                    name: "subagent",
                    arguments: JSON.stringify({
                      agent: "general",
                      description: "Write marker",
                      prompt: `${CHILD_MARKER} run the shell command`,
                      background: true,
                    }),
                  },
                },
              ],
            };
          }
          const base = {
            id: `bg-${requests}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
          };
          const finish = "tool_calls" in delta ? "tool_calls" : "stop";
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        });
      });
      let server: OpenCodeServe | undefined;
      let client: FetchOpenCodeClient | undefined;
      let removeClient: (() => void) | undefined;
      let sessionID: string | undefined;
      try {
        const listening = once(llm, "listening");
        llm.listen(0, "127.0.0.1");
        await listening;
        const address = llm.address();
        if (!address || typeof address === "string")
          throw new Error("Fixture listener is unavailable");
        await mkdir(directory);
        await mkdir(join(directories.configHome, "opencode"), {
          recursive: true,
        });
        await writeFile(
          join(directories.configHome, "opencode", "opencode.json"),
          JSON.stringify({
            autoupdate: false,
            providers: {
              mock: {
                package: "@opencode/ai/providers/openai-compatible",
                settings: {
                  baseURL: `http://127.0.0.1:${address.port}/v1`,
                  apiKey: "fixture",
                },
                models: { fixture: { name: "Fixture" } },
              },
            },
            model: "mock/fixture",
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "shell", resource: "*", effect: "ask" },
            ],
          }),
        );
        server = await startOpenCodeServe({
          service: true,
          directories,
          env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
        });
        client = new FetchOpenCodeClient({
          baseUrl: server.baseUrl,
          basicAuth: buildOpenCodeBasicAuth(server.password),
          defaultDirectory: false,
        });
        const api = client.api;
        const session = await api.session.create({
          title: "Background subagent recovery verification",
          location: { directory },
          model: { providerID: "mock", id: "fixture" },
        });
        sessionID = session.id;
        await api.session.prompt({
          sessionID: session.id,
          text: "Delegate the marker write in the background",
        });
        const childPending = async () => {
          const children = (
            await api.session.list({ parentID: session.id, limit: 10 })
          ).data;
          const lists = await Promise.all(
            children.map((child) =>
              api.permission.list({ sessionID: child.id }),
            ),
          );
          return lists.flat().filter((item) => item.action === "shell");
        };
        const parentTexts = async () =>
          (await api.message.list({ sessionID: session.id, limit: 50 })).data
            .filter((item) => item.type === "assistant")
            .flatMap((item) =>
              item.content.flatMap((part) =>
                part.type === "text" ? [part.text] : [],
              ),
            );
        await expect.poll(childPending, { timeout: 20000 }).toHaveLength(1);
        const beforeKill = (await childPending())[0]!;
        const childID = beforeKill.sessionID;
        const childRequestsBeforeKill = childRequests;
        expect(childID).not.toBe(session.id);
        await expect
          .poll(parentTexts, { timeout: 20000 })
          .toContain("Waiting for the child.");
        expect(existsSync(marker)).toBe(false);

        const previous = server;
        await previous.kill();
        server = undefined;
        server = await startOpenCodeServe({
          service: true,
          directories,
          port: previous.port,
          password: previous.password,
          env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
        });
        vi.spyOn(upstream, "getOpenCodeUpstreamBaseUrl").mockReturnValue(
          server.baseUrl,
        );
        sseAggregator.setPasswordResolver(() => previous.password);
        sseAggregator.setPendingActionsFetcher({ api });
        sseAggregator.start();

        await expect.poll(childPending, { timeout: 20000 }).toHaveLength(1);
        const current = (await childPending())[0]!;
        expect(current.sessionID).toBe(childID);
        expect(childRequests).toBeGreaterThan(childRequestsBeforeKill);
        const children = (
          await api.session.list({ parentID: session.id, limit: 10 })
        ).data;
        expect(children.map((item) => item.id)).toEqual([childID]);

        const observed: string[] = [];
        removeClient = sseAggregator.addClient(
          "background-subagent-recovery",
          (_event, data) => {
            const parsed = permissionEnvelope.safeParse(JSON.parse(data));
            if (
              parsed.success &&
              parsed.data.payload.data.sessionID === current.sessionID
            )
              observed.push(parsed.data.payload.data.id);
          },
          () => {},
          [directory],
        );
        await expect
          .poll(() => observed, { timeout: 10000 })
          .toContain(current.id);
        expect(existsSync(marker)).toBe(false);

        await api.permission.reply(
          { sessionID: current.sessionID, requestID: current.id, decision: "once" },
          { signal: AbortSignal.timeout(5000) },
        );
        await expect
          .poll(parentTexts, { timeout: 30000 })
          .toContain("Parent saw child done.");
        expect(await readFile(marker, "utf8")).toBe("approved\n");
        expect(await childPending()).toEqual([]);
      } finally {
        try {
          if (client && sessionID && server) {
            await client.api.session.interrupt(
              { sessionID },
              { signal: AbortSignal.timeout(5000) },
            );
            await client.api.session.remove(
              { sessionID },
              { signal: AbortSignal.timeout(5000) },
            );
          }
        } finally {
          removeClient?.();
          sseAggregator.shutdown();
          sseAggregator.setPendingActionsFetcher(null);
          sseAggregator.setPasswordResolver(null);
          vi.restoreAllMocks();
          llm.closeAllConnections();
          await new Promise<void>((resolve) => llm.close(() => resolve()));
          await server?.terminate();
          await rm(directories.root, { recursive: true, force: true });
        }
      }
    }, 240000);
  },
);
