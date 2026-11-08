import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OpenCodeServerProvider } from "@/contexts/OpenCodeServerContext";
import { searchMessages } from "@/api/messageSearch";
import { MessageSearchResults } from "./MessageSearchResults";

vi.mock("@/api/messageSearch", () => ({ searchMessages: vi.fn() }));

it("keeps existing matches visible when loading another page fails", async () => {
  vi.mocked(searchMessages)
    .mockResolvedValueOnce({
      results: Array.from({ length: 20 }, (_, index) => ({
        sessionId: `session-${index}`,
        sessionTitle: `Result ${index}`,
        directory: "/repo",
        archived: false,
        messageId: `message-${index}`,
        partId: `message-${index}:0`,
        role: "user",
        createdAt: 1,
        snippet: "match",
        highlights: [],
      })),
      hasMore: true,
      indexing: { complete: true, indexedRowid: 21, maxRowid: 21 },
    })
    .mockRejectedValueOnce(new Error("next page unavailable"));
  mount();
  await screen.findByRole("button", { name: /^Result 0/ });
  await userEvent.click(
    screen.getByRole("button", { name: "More matching messages" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: /^Result 0/ })).toBeVisible();
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function mount(serverId = "local", onSelectSession = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <OpenCodeServerProvider serverId={serverId}>
        <MessageSearchResults
          query="match"
          directories={["/repo"]}
          onSelectSession={onSelectSession}
        />
      </OpenCodeServerProvider>
    </QueryClientProvider>,
  );
  return onSelectSession;
}

it("shows escaped snippets and opens their owning session by keyboard", async () => {
  vi.mocked(searchMessages).mockResolvedValue({
    results: [
      {
        sessionId: "ses_match",
        sessionTitle: "Matching session",
        directory: "/repo",
        archived: false,
        messageId: "message",
        partId: "message:0",
        role: "user",
        createdAt: 1,
        snippet: "<img src=x> match",
        highlights: [{ start: 12, end: 17 }],
      },
    ],
    hasMore: false,
    indexing: { complete: true, indexedRowid: 1, maxRowid: 1 },
  });
  const select = mount();
  const button = await screen.findByRole("button", {
    name: /Matching session/,
  });
  expect(button.querySelector("img")).toBeNull();
  button.focus();
  await userEvent.keyboard("{Enter}");
  expect(select).toHaveBeenCalledExactlyOnceWith("ses_match");
});

it("does not report an empty partial index as having no matches", async () => {
  vi.mocked(searchMessages).mockResolvedValue({
    results: [],
    hasMore: false,
    indexing: { complete: false, indexedRowid: 0, maxRowid: 100 },
  });
  mount();
  expect(
    await screen.findByText("Indexing messages. Results may be incomplete."),
  ).toBeVisible();
  expect(screen.queryByText("No matching messages")).toBeNull();
});

it("keeps remote search explicitly unavailable without calling the local endpoint", () => {
  mount("remote");
  expect(
    screen.getByText("Message search is available on the local server only."),
  ).toBeVisible();
  expect(searchMessages).not.toHaveBeenCalled();
});

it("recovers an unavailable query through its retry control", async () => {
  vi.mocked(searchMessages)
    .mockRejectedValueOnce(new Error("private internal detail"))
    .mockResolvedValueOnce({
      results: [],
      hasMore: false,
      indexing: { complete: true, indexedRowid: 0, maxRowid: 0 },
    });
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Message search is unavailable.",
  );
  expect(screen.queryByText("private internal detail")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No matching messages")).toBeVisible();
});
