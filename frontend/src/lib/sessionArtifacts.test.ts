import { describe, expect, it } from "vitest";
import type { SessionMessageInfo } from "@opencode-manager/shared/opencode";
import recorded from "@/test/opencode2EditMessages.json";
import { extractSessionArtifacts } from "./sessionArtifacts";

const messages = recorded as unknown as SessionMessageInfo[];

function assistant(
  time: number,
  content: unknown[],
  snapshotFiles?: string[],
): SessionMessageInfo {
  return {
    id: `msg_${time}`,
    type: "assistant",
    agent: "build",
    model: { providerID: "mock", id: "fixture" },
    time: { created: time, completed: time },
    content,
    ...(snapshotFiles ? { snapshot: { files: snapshotFiles } } : {}),
  } as unknown as SessionMessageInfo;
}

const tool = (name: string, state: Record<string, unknown>) => ({
  type: "tool",
  id: `call_${name}`,
  name,
  state,
});

describe("extractSessionArtifacts", () => {
  it("reads write and edit results recorded by OpenCode 2.2.5", () => {
    const [artifact, ...rest] = extractSessionArtifacts(messages, "/repo");
    expect(rest).toEqual([]);
    expect(artifact).toMatchObject({
      path: "/repo/created.txt",
      displayPath: "created.txt",
      kind: "created",
      editCount: 2,
    });
    expect(artifact?.additions).toBeUndefined();
  });

  it("accumulates patch file statistics, honours deletions and keeps detected files only without tool evidence", () => {
    const artifacts = extractSessionArtifacts(
      [
        assistant(1, [
          tool("patch", {
            status: "completed",
            input: { patchText: "" },
            metadata: {
              files: [
                {
                  file: "a.ts",
                  status: "modified",
                  additions: 2,
                  deletions: 1,
                },
                {
                  file: "gone.ts",
                  status: "added",
                  additions: 1,
                  deletions: 0,
                },
              ],
            },
          }),
        ]),
        assistant(
          2,
          [
            tool("edit", {
              status: "completed",
              input: { path: "a.ts" },
              metadata: {
                files: [
                  {
                    file: "a.ts",
                    status: "modified",
                    additions: 3,
                    deletions: 0,
                  },
                ],
              },
            }),
            tool("patch", {
              status: "completed",
              input: {
                patchText:
                  "*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch",
              },
            }),
            tool("edit", { status: "error", input: { path: "failed.ts" } }),
          ],
          ["a.ts", "shell-made.txt"],
        ),
      ],
      "/repo",
    );
    expect(
      artifacts.map((artifact) => [
        artifact.displayPath,
        artifact.kind,
        artifact.editCount,
        artifact.additions,
        artifact.deletions,
      ]),
    ).toEqual([
      ["a.ts", "modified", 2, 5, 1],
      ["shell-made.txt", "detected", 0, undefined, undefined],
    ]);
  });

  it("normalizes absolute and parent-relative paths and ignores non-assistant messages", () => {
    const artifacts = extractSessionArtifacts(
      [
        {
          id: "msg_user",
          type: "user",
          text: "hi",
          time: { created: 0 },
        } as unknown as SessionMessageInfo,
        assistant(3, [
          tool("write", {
            status: "completed",
            input: { path: "/elsewhere/x.md" },
            content: [{ type: "text", text: "Updated file" }],
          }),
          tool("write", {
            status: "completed",
            input: { path: "sub/../y.md" },
            content: [
              { type: "text", text: "Created file successfully: y.md" },
            ],
          }),
        ]),
      ],
      "/repo/",
    );
    expect(
      artifacts.map((artifact) => [
        artifact.path,
        artifact.displayPath,
        artifact.kind,
      ]),
    ).toEqual([
      ["/elsewhere/x.md", "/elsewhere/x.md", "modified"],
      ["/repo/y.md", "y.md", "created"],
    ]);
  });
});
