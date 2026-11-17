import type { z } from "zod";
import { ClaudeProxyError } from "./claude-proxy-contract";

/** Options for one authenticated CLIProxyAPI management request. */
export type ProxyRequestOptions = {
  readonly method?: string;
  readonly body?: string;
  readonly timeoutMs?: number;
};

/**
 * Sends one management request to a loopback CLIProxyAPI and parses the JSON body with the given schema.
 * Upstream bodies are never surfaced; failures map to {@link ClaudeProxyError} codes.
 */
export async function proxyRequest<T>(
  endpoint: URL,
  managementKey: string,
  path: string,
  schema: z.ZodType<T>,
  options: ProxyRequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, endpoint), {
      method: options.method ?? "GET",
      ...(options.body === undefined ? {} : { body: options.body }),
      headers: {
        authorization: `Bearer ${managementKey}`,
        "content-type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
  } catch (error) {
    if (error instanceof Error) throw new ClaudeProxyError("UNAVAILABLE");
    throw error;
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new ClaudeProxyError("ACCESS_DENIED");
    if (
      path === "/v0/management/oauth-callback" &&
      [404, 409].includes(response.status)
    )
      throw new ClaudeProxyError("LOGIN_EXPIRED");
    throw new ClaudeProxyError("UNAVAILABLE");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ClaudeProxyError("INVALID_RESPONSE");
    if (error instanceof Error) throw new ClaudeProxyError("UNAVAILABLE");
    throw error;
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ClaudeProxyError("INVALID_RESPONSE");
  return parsed.data;
}
