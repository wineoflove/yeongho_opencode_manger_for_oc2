import { FileText, X } from "lucide-react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { SideDrawer } from "@/components/ui/side-drawer";
import { useMobile } from "@/hooks/useMobile";
import { formatDateTime } from "@/i18n/format";
import { msg, t } from "@/i18n/translate";
import type { SessionArtifact } from "@/lib/sessionArtifacts";

interface SessionArtifactsPanelProps {
  artifacts: SessionArtifact[];
  historyStatus: "complete" | "loading" | "partial";
  onClose: () => void;
  onFileClick: (path: string) => void;
}

const KIND_LABELS: Record<SessionArtifact["kind"], string> = {
  created: msg("File created"),
  modified: msg("File modified"),
  detected: msg("Detected in workspace"),
};

/** Lists the files the current session created or changed, newest first, and opens one in the file browser. */
export function SessionArtifactsPanel({
  artifacts,
  historyStatus,
  onClose,
  onFileClick,
}: SessionArtifactsPanelProps) {
  const isMobile = useMobile();
  const content = (
    <>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <h2 className="text-base font-semibold">
          {t("Artifacts")}{" "}
          <span className="text-muted-foreground">
            {historyStatus === "complete"
              ? artifacts.length
              : `${artifacts.length}+`}
          </span>
        </h2>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          aria-label={t("Close artifacts")}
          className="flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted focus-visible:outline focus-visible:outline-2"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <p className="py-3 text-xs text-muted-foreground">
          {t("Files changed in this session · newest first")}
          {historyStatus === "loading" && (
            <span className="block" role="status">
              {t("Checking earlier history for artifacts…")}
            </span>
          )}
          {historyStatus === "partial" && (
            <span className="block">
              {t(
                "Based on recent messages. Earlier history could not be loaded.",
              )}
            </span>
          )}
        </p>
        {artifacts.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <FileText className="mx-auto mb-3 h-8 w-8" aria-hidden="true" />
            {t(
              "No artifacts yet. Files appear here once they are created or changed.",
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {artifacts.map((artifact) => (
              <li key={artifact.path}>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onFileClick(artifact.path);
                  }}
                  className="min-h-11 w-full rounded-md px-2 py-3 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2"
                  title={artifact.path}
                >
                  <span className="block break-all text-sm font-medium">
                    {artifact.displayPath}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{t(KIND_LABELS[artifact.kind])}</span>
                    {artifact.editCount > 0 && (
                      <span>
                        {t("Edited {count} times", {
                          count: artifact.editCount,
                        })}
                      </span>
                    )}
                    <time dateTime={new Date(artifact.updatedAt).toISOString()}>
                      {formatDateTime(artifact.updatedAt)}
                    </time>
                    {artifact.additions !== undefined && (
                      <span className="text-success">
                        +{artifact.additions}
                      </span>
                    )}
                    {artifact.deletions !== undefined && (
                      <span className="text-destructive">
                        −{artifact.deletions}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {artifacts.some((artifact) => artifact.kind === "detected") && (
          <p className="pt-3 text-xs text-muted-foreground">
            {t(
              "Workspace detections can include changes from shell commands, subagents or other sessions.",
            )}
          </p>
        )}
        {artifacts.some((artifact) => artifact.additions !== undefined) && (
          <p className="pt-3 text-xs text-muted-foreground">
            {t(
              "Line counts accumulate completed edits and can differ from the final diff.",
            )}
          </p>
        )}
      </div>
    </>
  );
  return isMobile ? (
    <BottomSheet
      isOpen
      onClose={onClose}
      ariaLabel={t("Artifacts")}
      heightClass="h-[78dvh]"
    >
      {content}
    </BottomSheet>
  ) : (
    <SideDrawer
      isOpen
      onClose={onClose}
      ariaLabel={t("Artifacts")}
      widthClass="w-[min(90vw,420px)]"
    >
      {content}
    </SideDrawer>
  );
}
