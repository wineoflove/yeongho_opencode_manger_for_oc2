import type { SessionMessageInfo } from "@opencode-manager/shared/opencode";

/** A file the session created or changed, newest change first, with cumulative edit statistics when known. */
export interface SessionArtifact {
  path: string;
  displayPath: string;
  kind: "created" | "modified" | "detected";
  updatedAt: number;
  editCount: number;
  additions?: number;
  deletions?: number;
}

type Change = Omit<SessionArtifact, "displayPath" | "editCount" | "kind"> & {
  kind: SessionArtifact["kind"] | "deleted";
};

const PATCH_FILE =
  /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePath(value: unknown, directory: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const path =
    value.startsWith("/") || !directory ? value : `${directory}/${value}`;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length && segments.at(-1) !== "..")
      segments.pop();
    else if (segment !== ".." || !path.startsWith("/")) segments.push(segment);
  }
  return `${path.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

function stat(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function fileKind(status: unknown): Change["kind"] {
  if (status === "added" || status === "add" || status === "created")
    return "created";
  if (status === "deleted" || status === "delete") return "deleted";
  return "modified";
}

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content.map((item) => String(record(item).text ?? "")).join("")
    : "";
}

function collectMessageChanges(
  message: SessionMessageInfo,
  root: string,
): Change[] {
  if (message.type !== "assistant") return [];
  const changes: Change[] = [];
  const updatedAt = message.time.completed ?? message.time.created;
  const add = (
    file: unknown,
    kind: Change["kind"],
    stats: Record<string, unknown> = {},
  ) => {
    const path = normalizePath(file, root);
    if (path)
      changes.push({
        path,
        kind,
        updatedAt,
        additions: stat(stats.additions),
        deletions: stat(stats.deletions),
      });
  };
  for (const file of new Set(message.snapshot?.files ?? []))
    add(file, "detected");
  for (const item of message.content) {
    if (item.type !== "tool") continue;
    const state = record(item.state);
    if (state.status !== "completed") continue;
    const input = record(state.input);
    const files = Array.isArray(record(state.metadata).files)
      ? (record(state.metadata).files as unknown[])
      : [];
    if (item.name === "write") {
      add(
        input.path,
        textOf(state.content).startsWith("Created") ? "created" : "modified",
      );
    } else if (
      (item.name === "edit" || item.name === "patch") &&
      files.length
    ) {
      for (const value of files) {
        const file = record(value);
        add(file.file ?? file.path, fileKind(file.status), file);
      }
    } else if (item.name === "edit") {
      add(input.path, "modified");
    } else if (item.name === "patch" && typeof input.patchText === "string") {
      for (const match of input.patchText.matchAll(PATCH_FILE)) {
        if (match[3]) add(match[3].trim(), "modified");
        else
          add(
            match[2]?.trim(),
            match[1] === "Add"
              ? "created"
              : match[1] === "Delete"
                ? "deleted"
                : "modified",
          );
      }
    }
  }
  return changes;
}

/**
 * Reduces an OpenCode 2 transcript to the files its completed `write`, `edit` and `patch` calls produced, plus files
 * the workspace snapshot detected. Later deletions remove a file, a creation stays a creation across later edits,
 * and line statistics accumulate only while every contributing edit reported them.
 */
export function extractSessionArtifacts(
  messages: readonly SessionMessageInfo[],
  directory = "",
): SessionArtifact[] {
  const root = normalizePath(directory, "") ?? "";
  const changes = messages.flatMap((message) =>
    collectMessageChanges(message, root),
  );
  const toolPaths = new Set(
    changes
      .filter((change) => change.kind !== "detected")
      .map((change) => change.path),
  );
  const artifacts = new Map<string, SessionArtifact>();
  for (const change of changes.sort(
    (left, right) => left.updatedAt - right.updatedAt,
  )) {
    if (change.kind === "detected" && toolPaths.has(change.path)) continue;
    if (change.kind === "deleted") {
      artifacts.delete(change.path);
      continue;
    }
    const previous = artifacts.get(change.path);
    const sum = (left?: number, right?: number) =>
      previous
        ? left === undefined || right === undefined
          ? undefined
          : left + right
        : right;
    artifacts.set(change.path, {
      ...change,
      kind: previous?.kind === "created" ? "created" : change.kind,
      displayPath:
        root && change.path.startsWith(`${root === "/" ? "" : root}/`)
          ? change.path.slice(root === "/" ? 1 : root.length + 1)
          : change.path,
      editCount:
        change.kind === "detected" ? 0 : (previous?.editCount ?? 0) + 1,
      additions: sum(previous?.additions, change.additions),
      deletions: sum(previous?.deletions, change.deletions),
    });
  }
  return [...artifacts.values()].sort(
    (left, right) =>
      right.updatedAt - left.updatedAt || left.path.localeCompare(right.path),
  );
}
