import { Loader2, RefreshCw } from "lucide-react";
import type { AccountUsageResponse } from "@opencode-manager/shared/schemas";
import { FetchError } from "@opencode-manager/shared";
import { formatRelativeTime } from "@/i18n/format";
import { t } from "@/i18n/translate";
import { Button } from "@/components/ui/button";
import { AccountUsageCard } from "@/components/usage/AccountUsageCard";
import { useAccountUsage } from "@/hooks/useAccountUsage";
import { cn } from "@/lib/utils";

const PROVIDER_LABELS = {
  anthropic: "Claude",
  openai: "OpenAI",
} as const;

function UsageContent({ data }: { readonly data: AccountUsageResponse }) {
  return (
    <div className="space-y-6">
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          {t("Saved usage checked {time}", {
            time: formatRelativeTime(data.generatedAt),
          })}
        </p>
        <p>
          {t(
            "Usage comes from the rate limit headers of the last response each account served through CLIProxy. Accounts update after their next request.",
          )}
        </p>
      </div>
      {data.sources.map((source) => (
        <section
          key={source.provider}
          aria-labelledby={`usage-${source.provider}`}
          className="space-y-2"
        >
          <h2
            id={`usage-${source.provider}`}
            className="text-sm font-semibold text-muted-foreground"
          >
            {t("{provider} accounts", {
              provider: PROVIDER_LABELS[source.provider],
            })}
          </h2>
          {source.accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("No connected accounts")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {source.accounts.map((account) => (
                <AccountUsageCard key={account.accountKey} account={account} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** Per-account subscription usage of the CLIProxy-managed Claude and OpenAI accounts. */
export function Usage() {
  const query = useAccountUsage();
  const unconfigured =
    query.error instanceof FetchError &&
    query.error.code === "CLAUDE_PROXY_UNCONFIGURED";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <h1 className="text-lg font-semibold">{t("Usage")}</h1>
        <Button
          variant="outline"
          className="min-h-11 shrink-0 gap-2"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw
            className={cn(
              "size-4",
              query.isFetching && "motion-safe:animate-spin",
            )}
          />
          {t("Refresh")}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-3 md:pb-6 sm:px-6">
        <div className="mx-auto max-w-5xl">
          {query.isPending ? (
            <p
              role="status"
              className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" />
              {t("Loading account usage...")}
            </p>
          ) : query.isError ? (
            <div role="alert" className="space-y-3 py-8 text-sm">
              <p>
                {unconfigured
                  ? t(
                      "CLIProxy is not configured on this server, so there is no account usage to show.",
                    )
                  : t("Failed to load account usage")}
              </p>
              {!unconfigured && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => void query.refetch()}
                >
                  {t("Retry")}
                </Button>
              )}
            </div>
          ) : (
            <UsageContent data={query.data} />
          )}
        </div>
      </div>
    </div>
  );
}
