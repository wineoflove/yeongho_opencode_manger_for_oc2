import { describe, expect, it } from "vitest";
import {
  attributeUsage,
  type AttributableMessage,
} from "../../../src/services/stats/account-attribution";
import type { StoredUsageEvent } from "../../../src/db/cliproxy-usage-events";

const T0 = Date.parse("2026-11-17T05:30:25.579Z");

function message(
  fields: Partial<AttributableMessage> = {},
): AttributableMessage {
  return {
    id: "msg_a",
    sessionId: "ses_child",
    rootSessionId: "ses_root",
    provider: "anthropic",
    model: "claude-opus-5-5",
    createdAt: T0,
    completedAt: T0 + 2674,
    input: 2,
    output: 4,
    cacheRead: 0,
    ...fields,
  };
}

let nextRow = 1;
function event(fields: Partial<StoredUsageEvent> = {}): StoredUsageEvent {
  const rowId = nextRow++;
  return {
    rowId,
    id: `exec-${rowId}`,
    provider: "claude",
    authIndex: "0123456789abcdef",
    label: "a@example.test",
    sessionId: "3f1c2d4e-0000-4000-8000-000000000000",
    models: ["claude-opus-5-5"],
    failed: false,
    failureStatus: null,
    occurredAt: T0 + 14,
    tokens: {
      input: 3787,
      uncached: 2,
      cacheRead: 0,
      cacheWrite: 3785,
      output: 63,
      reasoning: 59,
      total: 3850,
    },
    ...fields,
  };
}

const openaiTokens = {
  input: 2664,
  uncached: 2664,
  cacheRead: 0,
  cacheWrite: 0,
  output: 5,
  reasoning: 0,
  total: 2669,
};

describe("account attribution", () => {
  it("matches the calibrated Claude and OpenAI pairs observed in OC2", () => {
    const claude = event({ authIndex: "0123456789abcdef" });
    const openai = event({
      provider: "codex",
      authIndex: "1111222233334444",
      models: ["gpt-6-astra"],
      occurredAt: T0 + 11_300 + 17,
      tokens: openaiTokens,
    });
    const result = attributeUsage(
      [
        message(),
        message({
          id: "msg_o",
          provider: "openai",
          model: "gpt-6-astra",
          createdAt: T0 + 11_300,
          completedAt: T0 + 13_360,
          input: 2664,
          output: 5,
          cacheRead: 0,
        }),
      ],
      [openai, claude],
    );
    expect(result).toEqual(
      new Map([
        ["msg_a", "0123456789abcdef"],
        ["msg_o", "1111222233334444"],
      ]),
    );
  });

  it.each([
    [-2000, true],
    [-2001, false],
    [2674 + 1000, true],
    [2674 + 1001, false],
  ])(
    "treats an event %i ms from creation as inside the window: %s",
    (offset, inside) => {
      const result = attributeUsage(
        [message()],
        [event({ occurredAt: T0 + offset })],
      );
      expect(result.has("msg_a")).toBe(inside);
    },
  );

  it("uses the creation time as the window end when the message is still open", () => {
    expect(
      attributeUsage(
        [message({ completedAt: null })],
        [event({ occurredAt: T0 + 1000 })],
      ).has("msg_a"),
    ).toBe(true);
    expect(
      attributeUsage(
        [message({ completedAt: null })],
        [event({ occurredAt: T0 + 1001 })],
      ).has("msg_a"),
    ).toBe(false);
  });

  it("prefers an event that carries the message or root session id", () => {
    const other = event({
      authIndex: "fedcba9876543210",
      sessionId: "unrelated",
    });
    const own = event({
      authIndex: "5555666677778888",
      sessionId: "ses_root",
      tokens: { ...event().tokens, output: 1 },
    });
    expect(attributeUsage([message()], [other, own]).get("msg_a")).toBe(
      "5555666677778888",
    );
  });

  it("breaks ties between concurrent events with the token fingerprint", () => {
    const wrong = event({
      authIndex: "fedcba9876543210",
      tokens: { ...event().tokens, output: 70, uncached: 9 },
    });
    const right = event({ authIndex: "0123456789abcdef" });
    expect(attributeUsage([message()], [wrong, right]).get("msg_a")).toBe(
      "0123456789abcdef",
    );
  });

  it("leaves a message unattributed when two events match equally well", () => {
    const first = event({ authIndex: "0123456789abcdef" });
    const second = event({ authIndex: "fedcba9876543210" });
    expect(attributeUsage([message()], [first, second]).has("msg_a")).toBe(
      false,
    );
  });

  it("requires more than a cache match without a session match", () => {
    const weak = event({
      tokens: { ...event().tokens, output: 99, uncached: 99 },
    });
    expect(attributeUsage([message()], [weak]).has("msg_a")).toBe(false);
  });

  it("consumes each event at most once, in creation order", () => {
    const only = event();
    const result = attributeUsage(
      [
        message({ id: "msg_late", createdAt: T0 + 10 }),
        message({ id: "msg_early" }),
      ],
      [only],
    );
    expect(result).toEqual(new Map([["msg_early", "0123456789abcdef"]]));
  });

  it("ignores failed events, other providers and other models", () => {
    const result = attributeUsage(
      [message(), message({ id: "msg_other", provider: "google" })],
      [
        event({ failed: true, failureStatus: 429 }),
        event({ provider: "codex" }),
        event({ models: ["gpt-6-luna"] }),
      ],
    );
    expect(result.size).toBe(0);
  });

  it("accepts a match on the alias or response model", () => {
    expect(
      attributeUsage(
        [message()],
        [event({ models: ["claude-opus-5-5-20261101", "claude-opus-5-5"] })],
      ).has("msg_a"),
    ).toBe(true);
  });

  it("attributes ten thousand messages against ten thousand events within a second", () => {
    const messages: AttributableMessage[] = [];
    const events: StoredUsageEvent[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      const createdAt = T0 + index * 1500;
      messages.push(
        message({
          id: `msg_${index}`,
          createdAt,
          completedAt: createdAt + 900,
          output: index % 50,
        }),
      );
      events.push(
        event({
          authIndex: index % 2 ? "0123456789abcdef" : "fedcba9876543210",
          occurredAt: createdAt + 15,
          tokens: { ...event().tokens, output: (index % 50) + 59 },
        }),
      );
    }
    const started = performance.now();
    const result = attributeUsage(messages, events.reverse());
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.size).toBe(10_000);
    expect(result.get("msg_1")).toBe("0123456789abcdef");
  });
});
