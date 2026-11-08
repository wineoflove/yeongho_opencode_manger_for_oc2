import { useInfiniteQuery } from "@tanstack/react-query";
import { searchMessages } from "@/api/messageSearch";
import { useOpenCodeServerId } from "@/contexts/OpenCodeServerContext";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { LOCAL_OPENCODE_SERVER_ID } from "@opencode-manager/shared/schemas";

export function useMessageSearch(
  query: string,
  directories: readonly string[],
) {
  const serverId = useOpenCodeServerId();
  const text = query.trim();
  const debounced = useDebouncedValue(text, 200);
  const scope = [...new Set(directories)].sort();
  const supported = serverId === LOCAL_OPENCODE_SERVER_ID;
  const enabled =
    supported &&
    text.length >= 2 &&
    text.length <= 200 &&
    text === debounced &&
    scope.length > 0 &&
    scope.length <= 100;
  const result = useInfiniteQuery({
    queryKey: ["message-search", serverId, debounced, scope],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      searchMessages(
        { q: debounced, directories: scope, limit: 20, offset: pageParam },
        signal,
      ),
    getNextPageParam: (last, pages) => {
      const next = pages.reduce(
        (count, page) => count + page.results.length,
        0,
      );
      return last.hasMore && next <= 10000 ? next : undefined;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (current) =>
      current.state.data?.pages.at(-1)?.indexing.complete === false
        ? 2000
        : false,
  });
  return {
    ...result,
    supported,
    enabled,
    waiting: text !== debounced,
    indexing: enabled && result.data?.pages.at(-1)?.indexing.complete === false,
    hits: enabled
      ? (result.data?.pages.flatMap((page) => page.results) ?? [])
      : [],
  };
}
