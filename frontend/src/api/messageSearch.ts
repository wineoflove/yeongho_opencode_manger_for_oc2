import { API_BASE_URL } from "@/config";
import {
  MessageSearchQuerySchema,
  MessageSearchResponseSchema,
  type MessageSearchQuery,
} from "@opencode-manager/shared/schemas";
import { fetchWrapper } from "./fetchWrapper";

export async function searchMessages(
  query: MessageSearchQuery,
  signal?: AbortSignal,
) {
  const parsed = MessageSearchQuerySchema.parse(query);
  const parameters = new URLSearchParams({
    q: parsed.q,
    limit: String(parsed.limit),
    offset: String(parsed.offset),
  });
  if (parsed.directory !== undefined)
    parameters.set("directory", parsed.directory);
  for (const directory of parsed.directories ?? [])
    parameters.append("directories", directory);
  parameters.set("serverId", "local");
  return MessageSearchResponseSchema.parse(
    await fetchWrapper<unknown>(
      `${API_BASE_URL}/api/messages/search?${parameters}`,
      { signal },
    ),
  );
}
