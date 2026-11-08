import { beforeEach, describe, expect, it } from "vitest";
import type { SessionTranscript } from "@/lib/session-projection/applySessionEvent";
import { useSendErrorStore, type SendError } from "@/stores/sendErrorStore";
import { reconcileConfirmedPrompt } from "./sendErrorReconcile";

function transcript(
  messages: unknown[] = [],
  pending: unknown[] = [],
): SessionTranscript {
  return { messages, pending, status: "idle" } as SessionTranscript;
}

const user = (text: string) => ({
  id: "msg_u",
  type: "user",
  text,
  time: { created: 1 },
});
const inbox = (text: string) => ({
  id: "msg_p",
  sessionID: "ses_a",
  type: "user",
  payload: { text },
  delivery: "queue",
  time: { created: 1 },
});

const setError = (patch: Partial<SendError>) =>
  useSendErrorStore
    .getState()
    .setError({
      sessionID: "ses_a",
      title: "Send failed",
      message: "offline",
      kind: "network",
      ...patch,
    });
const errorFor = (sessionID = "ses_a") =>
  useSendErrorStore.getState().getError(sessionID);

describe("reconcileConfirmedPrompt", () => {
  beforeEach(() => useSendErrorStore.setState({ errors: {} }));

  it("clears a network error when the failed prompt arrived as a user message", () => {
    setError({ failedPrompt: "  run the tests " });
    reconcileConfirmedPrompt("ses_a", transcript([user("run the tests")]));
    expect(errorFor()).toBeNull();
  });

  it("clears a network error when the failed prompt is waiting in the inbox", () => {
    setError({ failedPrompt: "run the tests" });
    reconcileConfirmedPrompt("ses_a", transcript([], [inbox("run the tests")]));
    expect(errorFor()).toBeNull();
  });

  it("keeps the error when the prompt text never arrived", () => {
    setError({ failedPrompt: "run the tests" });
    reconcileConfirmedPrompt(
      "ses_a",
      transcript([
        user("something else"),
        { id: "msg_a", type: "assistant", content: [] },
      ]),
    );
    expect(errorFor()?.failedPrompt).toBe("run the tests");
  });

  it("keeps errors that are not network failures", () => {
    setError({ failedPrompt: "run the tests", kind: undefined });
    reconcileConfirmedPrompt("ses_a", transcript([user("run the tests")]));
    expect(errorFor()).not.toBeNull();
  });

  it("ignores blank failed prompts and sessions without an error", () => {
    setError({ failedPrompt: "   " });
    reconcileConfirmedPrompt("ses_a", transcript([user("")]));
    expect(errorFor()).not.toBeNull();
    reconcileConfirmedPrompt("ses_b", transcript([user("   ")]));
    expect(errorFor("ses_b")).toBeNull();
  });
});
