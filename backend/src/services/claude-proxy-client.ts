import { z } from "zod";
import {
  ClaudeProxyError,
  credentialListSchema,
  proxyAuthStatusSchema,
  proxyAuthUrlSchema,
  proxyOkSchema,
  proxyProviderSettings,
  type ProxyProvider,
} from "./claude-proxy-contract";

export { ClaudeProxyError } from "./claude-proxy-contract";

export type ClaudeProxyAccount = {
  readonly id: string;
  readonly provider: ProxyProvider;
  readonly label: string | null;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastRefreshedAt: string | null;
  readonly nextRetryAt: string | null;
};

export type ClaudeProxyAccounts = {
  readonly observedAt: string;
  readonly accounts: readonly ClaudeProxyAccount[];
};

export class ClaudeProxyClient {
  private readonly endpoint: URL;

  constructor(
    private readonly settings: {
      readonly baseUrl: string;
      readonly managementKey: string;
      readonly pollIntervalMs?: number;
      readonly pollTimeoutMs?: number;
    },
  ) {
    const endpoint = new URL(settings.baseUrl);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash ||
      !settings.managementKey
    )
      throw new ClaudeProxyError("INVALID_ENDPOINT");
    this.endpoint = endpoint;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      readonly method?: string;
      readonly body?: string;
      readonly timeoutMs?: number;
    } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.endpoint), {
        method: options.method ?? "GET",
        ...(options.body === undefined ? {} : { body: options.body }),
        headers: {
          authorization: `Bearer ${this.settings.managementKey}`,
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

  private async credentials() {
    const data = await this.request(
      "/v8/management/credentials",
      credentialListSchema,
    );
    if (data.has_more) throw new ClaudeProxyError("PARTIAL_RESPONSE");
    const files = data.files.filter(
      (entry) => entry.provider === "claude" || entry.provider === "codex",
    );
    if (new Set(files.map((entry) => entry.auth_index)).size !== files.length)
      throw new ClaudeProxyError("INVALID_RESPONSE");
    return { observedAt: data.observed_at, files };
  }

  async listAccounts(): Promise<ClaudeProxyAccounts> {
    const data = await this.credentials();
    const accounts: ClaudeProxyAccount[] = data.files.map((entry) => ({
      id: entry.auth_index,
      provider: entry.provider === "claude" ? "claude" : "openai",
      label: entry.email?.trim() || entry.label?.trim() || null,
      enabled: !entry.disabled,
      available: !entry.disabled && !entry.unavailable,
      successCount: entry.success,
      failureCount: entry.failed,
      lastRefreshedAt: entry.last_refresh ?? null,
      nextRetryAt: entry.next_retry_after ?? null,
    }));
    accounts.sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) ||
        (left.label ?? "").localeCompare(right.label ?? ""),
    );
    return { observedAt: data.observedAt, accounts };
  }

  async startLogin(provider: ProxyProvider) {
    const config = proxyProviderSettings[provider];
    const data = await this.request(
      `/v0/management/${config.upstream}-auth-url`,
      proxyAuthUrlSchema,
    );
    const url = new URL(data.url);
    if (
      url.protocol !== "https:" ||
      url.host !== config.host ||
      url.username ||
      url.password
    )
      throw new ClaudeProxyError("INVALID_RESPONSE");
    return {
      provider,
      state: data.state,
      url: data.url,
      expiresAt: new Date(Date.now() + 300000).toISOString(),
    };
  }

  async completeLogin(input: {
    readonly provider: ProxyProvider;
    readonly state: string;
    readonly code: string;
  }) {
    await this.request("/v0/management/oauth-callback", proxyOkSchema, {
      method: "POST",
      body: JSON.stringify({
        provider: proxyProviderSettings[input.provider].upstream,
        state: input.state,
        code: input.code,
      }),
    });
    const deadline = Date.now() + (this.settings.pollTimeoutMs ?? 30000);
    const query = new URLSearchParams({ state: input.state });
    while (Date.now() < deadline) {
      let data: z.infer<typeof proxyAuthStatusSchema>;
      try {
        data = await this.request(
          `/v0/management/get-auth-status?${query}`,
          proxyAuthStatusSchema,
          {
            timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())),
          },
        );
      } catch (error) {
        if (
          error instanceof ClaudeProxyError &&
          error.code === "UNAVAILABLE" &&
          Date.now() >= deadline
        )
          throw new ClaudeProxyError("LOGIN_PENDING");
        throw error;
      }
      switch (data.status) {
        case "ok":
          return;
        case "error":
          throw new ClaudeProxyError("LOGIN_FAILED");
        case "wait":
          break;
      }
      const remaining = deadline - Date.now();
      if (remaining > 0)
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            Math.min(this.settings.pollIntervalMs ?? 500, remaining),
          ),
        );
    }
    throw new ClaudeProxyError("LOGIN_PENDING");
  }

  private async resolveAccount(id: string) {
    const data = await this.credentials();
    const account = data.files.find((entry) => entry.auth_index === id);
    if (!account) throw new ClaudeProxyError("ACCOUNT_NOT_FOUND");
    return account;
  }

  async setAccountEnabled(id: string, enabled: boolean) {
    const account = await this.resolveAccount(id);
    await this.request("/v0/management/auth-files/status", proxyOkSchema, {
      method: "PATCH",
      body: JSON.stringify({
        name: account.name,
        auth_index: id,
        disabled: !enabled,
      }),
    });
  }

  async deleteAccount(id: string) {
    const account = await this.resolveAccount(id);
    const query = new URLSearchParams({ name: account.name });
    await this.request(`/v0/management/auth-files?${query}`, proxyOkSchema, {
      method: "DELETE",
    });
  }
}
