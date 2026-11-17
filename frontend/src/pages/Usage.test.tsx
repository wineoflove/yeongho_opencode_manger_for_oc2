import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FetchError } from "@opencode-manager/shared";
import type { AccountUsageResponse } from "@opencode-manager/shared/schemas";
import { Usage } from "./Usage";
import { fetchAccountUsage } from "@/api/accountUsage";

vi.mock("@/api/accountUsage", () => ({ fetchAccountUsage: vi.fn() }));

const response: AccountUsageResponse = {
  generatedAt: Date.now(),
  sources: [
    {
      provider: "anthropic",
      status: "ok",
      accounts: [
        {
          provider: "anthropic",
          accountKey: "aa47ac1b75dc0765",
          label: "work@example.test",
          email: "work@example.test",
          enabled: true,
          state: "ok",
          confidence: "fresh",
          updatedAt: Date.now(),
          windows: [
            { key: "five_hour", label: "5 hours", usedPercent: 92 },
            { key: "seven_day", label: "7 days", usedPercent: 30 },
          ],
        },
      ],
    },
    { provider: "openai", status: "ok", accounts: [] },
  ],
};

function renderUsage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/usage"]}>
        <Usage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Usage page", () => {
  beforeEach(() => {
    vi.mocked(fetchAccountUsage).mockReset();
  });

  it("lists Claude and OpenAI accounts with their quota windows", async () => {
    vi.mocked(fetchAccountUsage).mockResolvedValue(response);
    renderUsage();

    const claude = await screen.findByRole("region", {
      name: "Claude accounts",
    });
    expect(within(claude).getAllByTestId("account-usage-card")).toHaveLength(1);
    expect(within(claude).getByText("work@example.test")).toBeInTheDocument();
    expect(within(claude).getByText("8% left")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "OpenAI accounts" })).getByText(
        "No connected accounts",
      ),
    ).toBeInTheDocument();
  });

  it("explains a server without CLIProxy instead of offering a retry", async () => {
    vi.mocked(fetchAccountUsage).mockImplementation(async () => {
      throw new FetchError("not configured", 404, "CLAUDE_PROXY_UNCONFIGURED")
    });
    renderUsage();

    expect(
      await screen.findByText(
        "CLIProxy is not configured on this server, so there is no account usage to show.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("offers a retry when the usage request fails", async () => {
    vi.mocked(fetchAccountUsage).mockImplementation(async () => {
      throw new FetchError("upstream", 502, "UNAVAILABLE")
    });
    renderUsage();

    expect(
      await screen.findByText("Failed to load account usage"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
