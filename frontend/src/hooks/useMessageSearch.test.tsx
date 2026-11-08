import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { OpenCodeServerProvider } from "@/contexts/OpenCodeServerContext";
import { searchMessages } from "@/api/messageSearch";
import { useMessageSearch } from "./useMessageSearch";

vi.mock("@/api/messageSearch", () => ({ searchMessages: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function wrapper(serverId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function SearchProvider({
    children,
  }: {
    readonly children: ReactNode;
  }) {
    return (
      <QueryClientProvider client={client}>
        <OpenCodeServerProvider serverId={serverId}>
          {children}
        </OpenCodeServerProvider>
      </QueryClientProvider>
    );
  };
}

it("never queries the local backend from a remote-server scope", () => {
  const { result } = renderHook(() => useMessageSearch("검색", ["/repo"]), {
    wrapper: wrapper("remote"),
  });
  expect(result.current.supported).toBe(false);
  expect(result.current.enabled).toBe(false);
  expect(searchMessages).not.toHaveBeenCalled();
});

it("deduplicates directory scope and does not request unbounded scope", async () => {
  vi.mocked(searchMessages).mockResolvedValue({
    results: [],
    hasMore: false,
    indexing: { complete: true, indexedRowid: 0, maxRowid: 0 },
  });
  const { result, rerender } = renderHook(
    ({ directories }) => useMessageSearch("검색", directories),
    {
      initialProps: { directories: ["/b", "/a", "/a"] },
      wrapper: wrapper("local"),
    },
  );
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(searchMessages).toHaveBeenCalledWith(
    { q: "검색", directories: ["/a", "/b"], limit: 20, offset: 0 },
    expect.any(AbortSignal),
  );
  vi.mocked(searchMessages).mockClear();
  rerender({ directories: [] });
  expect(result.current.enabled).toBe(false);
  expect(searchMessages).not.toHaveBeenCalled();
});

it("hides previous-query hits during debounce instead of showing stale matches", async () => {
  vi.mocked(searchMessages).mockResolvedValue({
    results: [
      {
        sessionId: "session",
        sessionTitle: "Title",
        directory: "/repo",
        archived: false,
        messageId: "message",
        partId: "message:0",
        role: "user",
        createdAt: 1,
        snippet: "first result",
        highlights: [],
      },
    ],
    hasMore: false,
    indexing: { complete: true, indexedRowid: 1, maxRowid: 1 },
  });
  const { result, rerender } = renderHook(
    ({ query }) => useMessageSearch(query, ["/repo"]),
    {
      initialProps: { query: "first" },
      wrapper: wrapper("local"),
    },
  );
  await waitFor(() => expect(result.current.hits).toHaveLength(1));
  rerender({ query: "second" });
  expect(result.current.waiting).toBe(true);
  expect(result.current.hits).toEqual([]);
});
