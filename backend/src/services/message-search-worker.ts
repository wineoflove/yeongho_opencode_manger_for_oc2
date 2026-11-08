import type {
  MessageSearchEngine,
  MessageSearchOptions,
} from "./message-search-engine";
import type { MessageSearchQuery } from "@opencode-manager/shared/schemas";

export type SearchWorkerRequest =
  | {
      readonly id: number;
      readonly kind: "search";
      readonly query: MessageSearchQuery;
    }
  | { readonly id: number; readonly kind: "close" };

export async function runMessageSearchWorker(
  Engine: typeof MessageSearchEngine,
): Promise<void> {
  const { parentPort, workerData } = await import("node:worker_threads");
  const { Database } = await import("bun:sqlite");
  if (!parentPort) throw new Error("Search worker requires parent port");
  const options: MessageSearchOptions = workerData;
  const engine = new Engine(Database, options);
  let refreshing: Promise<void> | undefined;
  let closing = false;
  let ready = false;
  let indexingFailed = false;
  const refresh = () => {
    refreshing ??= engine
      .refresh()
      .then(() => {
        ready = true;
        indexingFailed = false;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };
  const initial = refresh();
  void initial.catch(() => {
    indexingFailed = true;
    parentPort.postMessage({ error: "Message search initial indexing failed" });
  });
  const timer = setInterval(() => {
    if (closing) return;
    void refresh().catch(() => {
      indexingFailed = true;
      parentPort.postMessage({ error: "Message search indexing failed" });
    });
  }, 30000);
  parentPort.on("message", async (request: SearchWorkerRequest) => {
    try {
      switch (request.kind) {
        case "search":
          if (!ready && !indexingFailed && refreshing) {
            await Promise.race([
              refreshing.catch(() => undefined),
              new Promise<void>((resolve) => setTimeout(resolve, 2000)),
            ]);
          }
          if (!ready && indexingFailed)
            throw new Error("Message search indexing failed");
          if (closing) throw new Error("Message search is stopping");
          parentPort.postMessage({
            id: request.id,
            result: engine.search(request.query),
          });
          break;
        case "close":
          closing = true;
          clearInterval(timer);
          engine.stop();
          try {
            await refreshing;
          } finally {
            engine.close();
          }
          parentPort.postMessage({ id: request.id, result: null });
          parentPort.close();
          break;
        default: {
          const unreachable: never = request;
          throw new Error(
            `Unsupported search worker request: ${String(unreachable)}`,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      parentPort.postMessage({
        id: request.id,
        error: "Message search request failed",
      });
    }
  });
}
