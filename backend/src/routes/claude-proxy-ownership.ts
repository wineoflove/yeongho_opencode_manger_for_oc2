import type { MiddlewareHandler } from "hono";

export function protectNativeClaudeMutations(
  proxyOwnsInference: boolean,
): MiddlewareHandler {
  return async (c, next) => {
    if (
      proxyOwnsInference &&
      ["anthropic", "openai", "claude-agent"].includes(
        c.req.param("id") ?? "",
      ) &&
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
    )
      return c.json(
        {
          code: "CLAUDE_PROXY_MANAGED",
          error:
            "Claude, OpenAI and Claude Agent accounts are managed by CLIProxyAPI.",
        },
        409,
      );
    await next();
  };
}
