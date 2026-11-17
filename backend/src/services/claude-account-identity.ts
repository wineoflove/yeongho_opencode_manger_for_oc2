import { z } from "zod";

const profileURL = "https://api.anthropic.com/api/oauth/profile";

const poolSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            credentials: z
              .object({
                access: z.string().min(1),
                expires: z.number().finite(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .min(1)
      .max(20),
  })
  .passthrough();

const profileSchema = z
  .object({ account: z.object({ uuid: z.string().uuid() }).passthrough() })
  .passthrough();

export class ClaudeAccountIdentityError extends Error {
  constructor(
    readonly code:
      | "INVALID_POOL"
      | "ACCESS_EXPIRING"
      | "PROFILE_DENIED"
      | "PROFILE_UNAVAILABLE"
      | "PROFILE_INVALID"
      | "ACCOUNT_DUPLICATE",
    readonly status?: number,
  ) {
    super(code);
    this.name = "ClaudeAccountIdentityError";
  }
}

export async function resolveClaudeAccountIdentities(input: {
  readonly poolSource: string;
  readonly now: number;
  readonly minimumAccessLifetimeMs: number;
  readonly fetch: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<Record<string, string>> {
  let parsed;
  try {
    parsed = poolSchema.parse(JSON.parse(input.poolSource));
  } catch {
    throw new ClaudeAccountIdentityError("INVALID_POOL");
  }
  if (
    new Set(parsed.accounts.map((account) => account.id)).size !==
    parsed.accounts.length
  )
    throw new ClaudeAccountIdentityError("INVALID_POOL");
  for (const account of parsed.accounts)
    if (
      account.credentials.expires <=
      input.now + input.minimumAccessLifetimeMs
    )
      throw new ClaudeAccountIdentityError("ACCESS_EXPIRING");
  const identities: Record<string, string> = {};
  for (const account of parsed.accounts) {
    let response: Response;
    try {
      response = await input.fetch(profileURL, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(input.timeoutMs ?? 10000),
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "User-Agent": "axios/1.15.2",
          Authorization: `Bearer ${account.credentials.access}`,
          "Cache-Control": "no-cache",
        },
      });
    } catch {
      throw new ClaudeAccountIdentityError("PROFILE_UNAVAILABLE");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ClaudeAccountIdentityError("PROFILE_DENIED", response.status);
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ClaudeAccountIdentityError(
        "PROFILE_UNAVAILABLE",
        response.status,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ClaudeAccountIdentityError("PROFILE_INVALID");
    }
    const profile = profileSchema.safeParse(body);
    if (!profile.success)
      throw new ClaudeAccountIdentityError("PROFILE_INVALID");
    if (Object.values(identities).includes(profile.data.account.uuid))
      throw new ClaudeAccountIdentityError("ACCOUNT_DUPLICATE");
    identities[account.id] = profile.data.account.uuid;
  }
  return identities;
}
