import { Fragment, useId } from "react";
import { Button } from "@/components/ui/button";
import { useMessageSearch } from "@/hooks/useMessageSearch";
import { t } from "@/i18n/translate";
import { splitMessageSnippet } from "@/lib/messageSearchHighlights";

export function MessageSearchResults({
  query,
  directories,
  onSelectSession,
}: {
  readonly query: string;
  readonly directories: readonly string[];
  readonly onSelectSession: (sessionId: string) => void;
}) {
  const headingId = useId();
  const search = useMessageSearch(query, directories);
  const text = query.trim();
  if (text.length < 2) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="min-w-0 space-y-3 border-t border-border pt-4"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        {t("Message contents")}
      </h2>
      {!search.supported ? (
        <p className="text-sm text-muted-foreground">
          {t("Message search is available on the local server only.")}
        </p>
      ) : text.length > 200 ? (
        <p className="text-sm text-muted-foreground">
          {t("Use at most 200 characters to search messages.")}
        </p>
      ) : directories.length > 100 ? (
        <p className="text-sm text-muted-foreground">
          {t("Select at most 100 directories to search messages.")}
        </p>
      ) : search.waiting || search.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("Searching message contents...")}
        </p>
      ) : search.isError && search.hits.length === 0 ? (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-muted-foreground">
            {t("Message search is unavailable.")}
          </p>
          <Button
            variant="outline"
            className="h-11 min-w-28"
            onClick={() => void search.refetch()}
            disabled={search.isFetching}
          >
            {t("Retry")}
          </Button>
        </div>
      ) : (
        <>
          {search.indexing && (
            <p role="status" className="text-sm text-muted-foreground">
              {t("Indexing messages. Results may be incomplete.")}
            </p>
          )}
          {search.hits.length === 0 ? (
            search.indexing ? null : (
              <p role="status" className="text-sm text-muted-foreground">
                {t("No matching messages")}
              </p>
            )
          ) : (
            <ul className="space-y-2">
              {search.hits.map((hit) => (
                <li key={hit.partId}>
                  <button
                    type="button"
                    onClick={() => onSelectSession(hit.sessionId)}
                    className="w-full min-w-0 rounded-md border border-border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <span className="block break-words text-sm font-medium">
                      {hit.sessionTitle || t("Untitled session")}
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                      {splitMessageSnippet(hit.snippet, hit.highlights).map((segment, index) =>
                        segment.highlighted ? (
                          <mark
                            key={index}
                            className="rounded-sm bg-accent text-accent-foreground font-semibold"
                          >
                            {segment.text}
                          </mark>
                        ) : (
                          <Fragment key={index}>{segment.text}</Fragment>
                        ),
                      )}
                    </span>
                    <span className="mt-2 block break-all text-xs text-muted-foreground">
                      {hit.role === "user" ? t("User") : t("Assistant")}
                      {hit.archived ? ` · ${t("Archived")}` : ""} ·{" "}
                      {hit.directory}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {search.isFetchNextPageError && (
            <p role="alert" className="text-sm text-muted-foreground">
              {t("Could not load more matching messages.")}
            </p>
          )}
          {search.hasNextPage && (
            <Button
              variant="outline"
              className="h-11 min-w-40"
              onClick={() => void search.fetchNextPage()}
              disabled={search.isFetchingNextPage}
            >
              {search.isFetchingNextPage
                ? t("Loading...")
                : search.isFetchNextPageError
                  ? t("Retry")
                  : t("More matching messages")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
