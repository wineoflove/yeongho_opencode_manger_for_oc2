import { expect, test } from "bun:test";
import { openCodeApi } from "./opencode.mjs";
import { publishExactReport } from "./report-delivery.mjs";

test("noReply delivery uses the report endpoint, verifies the saved message and never prompts", async () => {
  const messages = new Map();
  let prompts = 0;
  let reports = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/prompt")) {
        prompts++;
        return new Response(null, { status: 500 });
      }
      if (path.endsWith("/report")) {
        reports++;
        expect(request.headers.get("authorization")).toBe(
          "Bearer synthetic-token",
        );
        const input = await request.json();
        messages.set(input.messageID, {
          id: input.messageID,
          type: "synthetic",
          text: input.text,
          metadata: { source: "manager-report" },
          time: { created: 1 },
        });
        return Response.json({
          data: { messageID: input.messageID, reused: false },
        });
      }
      if (path.includes("/message/")) {
        const message = messages.get(path.split("/").at(-1));
        return message
          ? Response.json({ data: message })
          : Response.json({ _tag: "MessageNotFoundError" }, { status: 404 });
      }
      return new Response(null, { status: 404 });
    },
  });
  try {
    const api = openCodeApi({
      OCM_INTERNAL_API_URL: `http://127.0.0.1:${server.port}/api/internal`,
      OCM_INTERNAL_TOKEN: "synthetic-token",
    });
    const config = { delivery: "noReply", feedbackSession: "ses_fixture" };
    await publishExactReport(config, "msg_report", "synthetic report", api);
    await publishExactReport(config, "msg_report", "synthetic report", api);
    expect(reports).toBe(1);
    expect(prompts).toBe(0);
    await expect(
      publishExactReport(config, "msg_report", "changed", api),
    ).rejects.toThrow("Report ID content mismatch");
    expect(messages.get("msg_report").text).toBe("synthetic report");
  } finally {
    await server.stop(true);
  }
});

test("an older server without report support fails closed instead of submitting a prompt", async () => {
  let prompts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith("/prompt")) prompts++;
      return Response.json({ _tag: "MessageNotFoundError" }, { status: 404 });
    },
  });
  try {
    const api = openCodeApi({
      OCM_INTERNAL_API_URL: `http://127.0.0.1:${server.port}/api/internal`,
      OCM_INTERNAL_TOKEN: "synthetic-token",
    });
    await expect(
      publishExactReport(
        { delivery: "noReply", feedbackSession: "ses_fixture" },
        "msg_report",
        "report",
        api,
      ),
    ).rejects.toThrow("NO_REPLY_DELIVERY_REJECTED");
    expect(prompts).toBe(0);
  } finally {
    await server.stop(true);
  }
});
