import { createOpenCodeApi } from "../../shared/src/opencode/index.ts";
import { z } from "../../shared/src/zod.ts";

export class ReportDeliveryError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "ReportDeliveryError";
    this.status = status;
  }
}

const reportInput = z
  .object({
    sessionID: z.string().regex(/^ses_[A-Za-z0-9]+$/),
    messageID: z.string().regex(/^msg_[A-Za-z0-9_]+$/),
    text: z.string(),
  })
  .strict();

/**
 * OpenCode 2 API client that reaches the Manager's OpenCode server through the internal-token proxy,
 * using the `OCM_INTERNAL_API_URL` and `OCM_INTERNAL_TOKEN` the Manager passes to OpenCode and its shell commands.
 */
export function openCodeApi(env = process.env, fetcher = fetch) {
  const internal = env.OCM_INTERNAL_API_URL;
  const token = env.OCM_INTERNAL_TOKEN;
  if (!internal || !token) throw new Error("OCM_INTERNAL_API_UNAVAILABLE");
  const baseUrl = new URL("/api/opencode-proxy", internal).href;
  const api = createOpenCodeApi({
    baseUrl,
    fetch: fetcher,
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    ...api,
    session: {
      ...api.session,
      report: async (input) => {
        const parsed = reportInput.parse(input);
        const response = await fetcher(
          `${baseUrl}/api/experimental/session/${encodeURIComponent(parsed.sessionID)}/report`,
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(30000),
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messageID: parsed.messageID,
              text: parsed.text,
            }),
          },
        );
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new ReportDeliveryError(
            "NO_REPLY_DELIVERY_REJECTED",
            response.status,
          );
        }
        return z
          .object({
            data: z.object({
              messageID: z.literal(parsed.messageID),
              reused: z.boolean(),
            }),
          })
          .parse(await response.json()).data;
      },
    },
  };
}
