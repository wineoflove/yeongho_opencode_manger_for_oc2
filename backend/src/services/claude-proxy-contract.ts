import { z } from "zod";
import { usageCredentialFieldsSchema } from "./claude-proxy-usage-contract";

export const proxyProviderSchema = z.enum(["claude", "openai"]);
export type ProxyProvider = z.infer<typeof proxyProviderSchema>;
export const proxyAccountIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const proxyLoginSchema = z
  .object({ provider: proxyProviderSchema })
  .strict();
export const proxyCompleteSchema = proxyLoginSchema
  .extend({ state: z.string().min(1), redirectUrl: z.string().min(1) })
  .strict();
export const proxyEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export const proxyOkSchema = z.object({ status: z.literal("ok") });
export const proxyAuthUrlSchema = proxyOkSchema.extend({
  url: z.string().url(),
  state: z.string().min(1),
});
export const proxyAuthStatusSchema = z.object({
  status: z.enum(["ok", "wait", "error"]),
});
export const credentialListSchema = z.object({
  observed_at: z.string().datetime({ offset: true }),
  has_more: z.boolean().optional(),
  files: z.array(
    z.object({
      auth_index: proxyAccountIdSchema,
      provider: z.string(),
      name: z.string().min(1),
      email: z.string().optional(),
      label: z.string().optional(),
      disabled: z.boolean(),
      unavailable: z.boolean(),
      success: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      last_refresh: z.string().datetime({ offset: true }).optional(),
      next_retry_after: z.string().datetime({ offset: true }).optional(),
    }).merge(usageCredentialFieldsSchema),
  ),
});

export const proxyProviderSettings = {
  claude: { upstream: "anthropic", host: "claude.ai", callback: "/callback" },
  openai: {
    upstream: "codex",
    host: "auth.openai.com",
    callback: "/auth/callback",
  },
} as const;

export class ClaudeProxyError extends Error {
  constructor(
    readonly code:
      | "INVALID_ENDPOINT"
      | "UNAVAILABLE"
      | "ACCESS_DENIED"
      | "INVALID_RESPONSE"
      | "PARTIAL_RESPONSE"
      | "ACCOUNT_NOT_FOUND"
      | "INVALID_REDIRECT"
      | "LOGIN_DENIED"
      | "LOGIN_EXPIRED"
      | "LOGIN_FAILED"
      | "LOGIN_PENDING",
  ) {
    super(code);
    this.name = "ClaudeProxyError";
  }

  get status() {
    switch (this.code) {
      case "ACCOUNT_NOT_FOUND":
        return 404;
      case "INVALID_REDIRECT":
      case "LOGIN_DENIED":
        return 400;
      case "LOGIN_EXPIRED":
        return 409;
      case "LOGIN_PENDING":
        return 504;
      default:
        return 502;
    }
  }
}

export function proxyCallbackCode(
  input: z.infer<typeof proxyCompleteSchema>,
): string {
  let url: URL;
  try {
    url = new URL(input.redirectUrl);
  } catch (error) {
    if (error instanceof TypeError)
      throw new ClaudeProxyError("INVALID_REDIRECT");
    throw error;
  }
  if (url.searchParams.has("error")) throw new ClaudeProxyError("LOGIN_DENIED");
  const rawCode = url.searchParams.get("code") ?? "";
  const code = input.provider === "claude" ? rawCode.split("#")[0] : rawCode;
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== proxyProviderSettings[input.provider].callback ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== input.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !code?.trim()
  ) {
    throw new ClaudeProxyError("INVALID_REDIRECT");
  }
  return code;
}
