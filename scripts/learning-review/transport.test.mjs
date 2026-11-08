import { expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisUsage, analyze } from "./transport.mjs";
import { publishExactReport } from "./report-delivery.mjs";

const config = {
  directory: "/fixture",
  models: { daily: "provider/first", weekly: "provider/nested/model" },
};
const analysis = { summary: "fixture", lessons: [] };
const first = {
  id: "msg_a",
  type: "assistant",
  model: { providerID: "provider", id: "first" },
  finish: "tool-calls",
  time: { created: 1, completed: 2 },
  tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
  cost: 0.25,
  content: [],
};
const final = {
  id: "msg_b",
  type: "assistant",
  model: { providerID: "other", id: "second" },
  finish: "stop",
  time: { created: 3, completed: 4 },
  tokens: { input: 7 },
  content: [
    { type: "reasoning", text: "ignored" },
    { type: "text", text: `\`\`\`json\n${JSON.stringify(analysis)}\n\`\`\`` },
  ],
};
const expectedUsage = {
  input: 17,
  output: 2,
  reasoning: 3,
  cacheRead: 4,
  cacheWrite: 5,
  cost: 0.25,
  models: {
    "provider/first": {
      input: 10,
      output: 2,
      reasoning: 3,
      cacheRead: 4,
      cacheWrite: 5,
      cost: 0.25,
    },
    "other/second": {
      input: 7,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
  },
};

function fakeApi(readMessages, { promptError = null } = {}) {
  const calls = [];
  let reads = 0;
  const api = {
    session: {
      create: async (input) => {
        calls.push(["create", input]);
        return { id: "ses_usage" };
      },
      prompt: async (input) => {
        calls.push(["prompt", input.sessionID]);
        if (promptError) throw promptError;
      },
      interrupt: async (input) => calls.push(["interrupt", input.sessionID]),
      remove: async (input) => calls.push(["remove", input.sessionID]),
    },
    message: {
      list: async (input) => {
        calls.push(["list", input.type]);
        return { data: await readMessages(++reads), cursor: { next: null } };
      },
    },
  };
  return { api, calls };
}

let clock = 0;
const instant = () => clock;

it("creates a tool-free analysis session and returns assistant-only usage without double counting polls", async () => {
  const { api, calls } = fakeApi((read) =>
    read === 1 ? [first] : [first, final],
  );
  expect(await analyze(config, "daily", [], [], api, instant)).toEqual({
    analysis,
    usage: expectedUsage,
  });
  const create = calls[0][1];
  expect(create).toMatchObject({
    agent: "assistant",
    model: { providerID: "provider", id: "first" },
    location: { directory: "/fixture" },
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
  });
  expect(create.model.variant).toBeUndefined();
  expect(calls.slice(-2)).toEqual([
    ["interrupt", "ses_usage"],
    ["remove", "ses_usage"],
  ]);
});

it("keeps nested model ids and asks for the low variant in weekly mode", async () => {
  const { api, calls } = fakeApi(() => [final]);
  await analyze(config, "weekly", [], [], api, instant);
  expect(calls[0][1].model).toEqual({
    providerID: "provider",
    id: "nested/model",
    variant: "low",
  });
});

it("refreshes usage after a model error and still removes the session", async () => {
  const { api, calls } = fakeApi((read) =>
    read === 1 ? [{ ...first, error: { type: "provider" } }] : [first, final],
  );
  const error = await analyze(config, "daily", [], [], api, instant).catch(
    (caught) => caught,
  );
  expect(error.message).toBe("Learning analysis model returned an error");
  expect(error.analysisUsage).toEqual(expectedUsage);
  expect(calls.at(-1)).toEqual(["remove", "ses_usage"]);
});

it("keeps the unparsed analysis text when the model returns invalid JSON", async () => {
  const { api } = fakeApi(() => [
    { ...final, content: [{ type: "text", text: "not json" }] },
  ]);
  const error = await analyze(config, "daily", [], [], api, instant).catch(
    (caught) => caught,
  );
  expect(error.analysisText).toBe("not json");
});

it("reports a rejected prompt with null usage when the reread also fails, and still cleans up", async () => {
  const { api, calls } = fakeApi(
    () => {
      throw new Error("list failed");
    },
    { promptError: new Error("prompt rejected") },
  );
  const error = await analyze(config, "daily", [], [], api, instant).catch(
    (caught) => caught,
  );
  expect(error.message).toBe("prompt rejected");
  expect(error.analysisUsage).toBeNull();
  expect(calls.slice(-2)).toEqual([
    ["interrupt", "ses_usage"],
    ["remove", "ses_usage"],
  ]);
});

it("stops at the 180-second deadline with the last observed usage", async () => {
  let now = 0;
  const { api } = fakeApi(() => {
    now += 100000;
    return [first];
  });
  const error = await analyze(config, "daily", [], [], api, () => now).catch(
    (caught) => caught,
  );
  expect(error.message).toBe("Learning analysis exceeded 180 seconds");
  expect(error.analysisUsage.input).toBe(10);
});

it("counts absent optional usage as zero and ignores non-assistant messages", () => {
  expect(
    analysisUsage([
      { type: "user", tokens: { input: 99 } },
      { type: "assistant", model: { providerID: "p", id: "m" } },
    ]),
  ).toEqual({
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    models: {
      "p/m": {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
    },
  });
});

function feedbackApi({ conflictOnce = false, rewrite = (text) => text } = {}) {
  const messages = new Map();
  const prompts = [];
  return {
    prompts,
    messages,
    api: {
      session: {
        message: {
          get: async ({ sessionID, messageID }) => {
            const message = messages.get(`${sessionID}/${messageID}`);
            if (!message)
              throw Object.assign(new Error("missing"), {
                _tag: "MessageNotFoundError",
              });
            return message;
          },
        },
        prompt: async ({ sessionID, id, text }) => {
          prompts.push({ sessionID, id, text });
          messages.set(`${sessionID}/${id}`, {
            id,
            type: "user",
            text: rewrite(text),
          });
          if (conflictOnce && prompts.length === 1)
            throw Object.assign(new Error("conflict"), {
              _tag: "ConflictError",
            });
        },
      },
    },
  };
}

it("posts a prompt report once under its durable id and rejects different text for that id", async () => {
  const feedback = feedbackApi();
  const settings = { delivery: "prompt", feedbackSession: "ses_feedback" };
  await publishExactReport(settings, "msg_report", "보고서", feedback.api);
  await publishExactReport(settings, "msg_report", "보고서", feedback.api);
  expect(feedback.prompts).toEqual([
    { sessionID: "ses_feedback", id: "msg_report", text: "보고서" },
  ]);
  await expect(
    publishExactReport(settings, "msg_report", "다른 보고서", feedback.api),
  ).rejects.toThrow("mismatch");
});

it("treats a durable-id conflict as an earlier delivery and verifies the stored text", async () => {
  const feedback = feedbackApi({ conflictOnce: true });
  await publishExactReport(
    { delivery: "prompt", feedbackSession: "ses_feedback" },
    "msg_retry",
    "report",
    feedback.api,
  );
  expect(feedback.prompts).toHaveLength(1);
});

it("rejects a prompt report whose stored text was modified", async () => {
  const feedback = feedbackApi({ rewrite: (text) => `${text}\n변형` });
  await expect(
    publishExactReport(
      { delivery: "prompt", feedbackSession: "ses_feedback" },
      "msg_modified",
      "보고서",
      feedback.api,
    ),
  ).rejects.toThrow("Report ID content mismatch");
});

it("stores file reports exactly once and requires a configured delivery channel", async () => {
  const store = await mkdtemp(join(tmpdir(), "learning-delivery-"));
  try {
    const settings = { delivery: "file", store };
    await publishExactReport(settings, "msg_file", "report");
    await publishExactReport(settings, "msg_file", "report");
    expect(
      await readFile(
        join(store, "reviews", "delivered", "msg_file.md"),
        "utf8",
      ),
    ).toBe("report");
    await expect(
      publishExactReport(settings, "msg_file", "changed"),
    ).rejects.toThrow("mismatch");
    await expect(
      publishExactReport({ store }, "msg_file", "report"),
    ).rejects.toThrow("LEARNING_REVIEW_DELIVERY_UNCONFIGURED");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
