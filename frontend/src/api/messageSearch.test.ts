import { beforeEach, expect, it, vi } from "vitest";
import { searchMessages } from "./messageSearch";
import { fetchWrapper } from "./fetchWrapper";

vi.mock("./fetchWrapper", () => ({ fetchWrapper: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("encodes repeated directory scope without splitting path punctuation and forwards cancellation", async () => {
  vi.mocked(fetchWrapper).mockResolvedValue({
    results: [],
    hasMore: false,
    indexing: { complete: true, indexedRowid: 0, maxRowid: 0 },
  });
  const signal = new AbortController().signal;
  await searchMessages(
    {
      q: " 검색 ",
      directories: ["/repo/a&b", "/repo/한 글"],
      limit: 20,
      offset: 40,
    },
    signal,
  );
  const call = vi.mocked(fetchWrapper).mock.calls[0];
  expect(call).toBeDefined();
  const url = new URL(String(call?.[0]), "http://fixture.invalid");
  expect(url.pathname).toBe("/api/messages/search");
  expect(url.searchParams.getAll("directories")).toEqual([
    "/repo/a&b",
    "/repo/한 글",
  ]);
  expect(url.searchParams.get("q")).toBe("검색");
  expect(url.searchParams.get("serverId")).toBe("local");
  expect(url.searchParams.get("offset")).toBe("40");
  expect(call?.[1]?.signal).toBe(signal);
});

it("rejects malformed successful payloads instead of displaying an empty successful search", async () => {
  vi.mocked(fetchWrapper).mockResolvedValue({
    results: "invalid",
    hasMore: false,
  });
  await expect(
    searchMessages({ q: "term", limit: 20, offset: 0 }),
  ).rejects.toThrow();
});
