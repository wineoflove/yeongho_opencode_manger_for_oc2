import { describe, expect, it, vi } from "vitest";
import { resolveClaudeAccountIdentities } from "../../src/services/claude-account-identity";

const now = 1800000000000;
const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";
const pool = (expires = now + 3600000) =>
  JSON.stringify({
    version: 1,
    accounts: [
      {
        id: "main",
        credentials: {
          type: "oauth",
          access: "synthetic-access-a",
          refresh: "r",
          expires,
        },
      },
      {
        id: "second",
        credentials: {
          type: "oauth",
          access: "synthetic-access-b",
          refresh: "r",
          expires,
        },
      },
    ],
  });
const profile = (uuid: string) =>
  Response.json({ account: { uuid, email: "synthetic@example.test" } });
const base = { now, minimumAccessLifetimeMs: 600000 };

describe("Claude account identity resolution", () => {
  it("stops before the third profile when the second account UUID is duplicated", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => profile(uuidA));
    try {
      await expect(
        resolveClaudeAccountIdentities({
          ...base,
          poolSource: JSON.stringify({
            accounts: ["main", "second", "third"].map((id) => ({
              id,
              credentials: {
                access: `synthetic-${id}`,
                expires: now + 3600000,
              },
            })),
          }),
          fetch: globalThis.fetch,
        }),
      ).rejects.toMatchObject({ code: "ACCOUNT_DUPLICATE" });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("maps each pool account to the profile account UUID using the CLIProxy profile request shape", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return profile(
          headers.get("authorization") === "Bearer synthetic-access-a"
            ? uuidA
            : uuidB,
        );
      },
    );
    expect(
      await resolveClaudeAccountIdentities({
        ...base,
        poolSource: pool(),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).toEqual({ main: uuidA, second: uuidB });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("user-agent")).toBe("axios/1.15.2");
  });

  it("refuses expiring access tokens without any provider request", async () => {
    const fetch = vi.fn();
    await expect(
      resolveClaudeAccountIdentities({
        ...base,
        poolSource: pool(now + 1000),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "ACCESS_EXPIRING" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, "PROFILE_DENIED"],
    [403, "PROFILE_DENIED"],
    [429, "PROFILE_UNAVAILABLE"],
    [500, "PROFILE_UNAVAILABLE"],
  ])(
    "stops at HTTP %s with %s and never exposes the token",
    async (status, code) => {
      const fetch = vi.fn(
        async () => new Response("synthetic-access-a leaked body", { status }),
      );
      const error = await resolveClaudeAccountIdentities({
        ...base,
        poolSource: pool(),
        fetch: fetch as unknown as typeof globalThis.fetch,
      }).catch((value: unknown) => value);
      expect(error).toMatchObject({ code, status });
      expect(String(error)).not.toContain("synthetic-access");
      expect(JSON.stringify(error)).not.toContain("synthetic-access");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects malformed profiles, duplicate accounts and invalid pools", async () => {
    const malformed = vi.fn(async () =>
      Response.json({ account: { uuid: "not-a-uuid" } }),
    );
    await expect(
      resolveClaudeAccountIdentities({
        ...base,
        poolSource: pool(),
        fetch: malformed as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "PROFILE_INVALID" });
    const duplicate = vi.fn(async () => profile(uuidA));
    await expect(
      resolveClaudeAccountIdentities({
        ...base,
        poolSource: pool(),
        fetch: duplicate as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_DUPLICATE" });
    await expect(
      resolveClaudeAccountIdentities({
        ...base,
        poolSource: "{",
        fetch: duplicate as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toMatchObject({ code: "INVALID_POOL" });
    const network = vi.fn(async () => {
      throw new Error("synthetic-access-a network");
    });
    const error = await resolveClaudeAccountIdentities({
      ...base,
      poolSource: pool(),
      fetch: network as unknown as typeof globalThis.fetch,
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "PROFILE_UNAVAILABLE" });
    expect(String(error)).not.toContain("synthetic-access");
  });
});
