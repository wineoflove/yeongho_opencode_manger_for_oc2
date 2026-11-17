import type { Database } from "bun:sqlite";
import { insertUsageEvents } from "../db/cliproxy-usage-events";
import { logger } from "../utils/logger";
import type { ProxyUsageRecord } from "./claude-proxy-usage-contract";

/** The CLIProxyAPI operations the collector needs. */
export type UsageCollectorClient = {
  popUsageQueue(count: number): Promise<{
    readonly received: number;
    readonly rejected: number;
    readonly records: readonly ProxyUsageRecord[];
  }>;
  listAccounts(): Promise<{
    readonly accounts: readonly {
      readonly id: string;
      readonly label: string | null;
    }[];
  }>;
};

/** Totals for one collection pass. */
export type UsageCollectorTick = {
  readonly received: number;
  readonly inserted: number;
  readonly skipped: number;
  readonly rejected: number;
};

/** Drains the acknowledgement-free CLIProxyAPI usage queue into Manager's database, one pass at a time. */
export class CliproxyUsageCollector {
  private labels: ReadonlyMap<string, string> | null = null;
  private running: Promise<UsageCollectorTick> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: {
      readonly client: UsageCollectorClient;
      readonly db: Database;
      readonly pageSize: number;
      readonly maxPagesPerTick: number;
      readonly intervalMs: number;
      readonly now?: () => number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduled();
    }, this.options.intervalMs);
    void this.runScheduled();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  tick(): Promise<UsageCollectorTick> {
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runScheduled(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      logger.error("CLIProxy usage collection failed", error);
    }
  }

  private async accountLabels(): Promise<ReadonlyMap<string, string>> {
    if (this.labels) return this.labels;
    try {
      const { accounts } = await this.options.client.listAccounts();
      this.labels = new Map(
        accounts.flatMap((account) =>
          account.label ? [[account.id, account.label] as const] : [],
        ),
      );
      return this.labels;
    } catch (error) {
      logger.warn(
        "CLIProxy account labels unavailable for usage events",
        error,
      );
      return new Map();
    }
  }

  private async drain(): Promise<UsageCollectorTick> {
    const { client, db, pageSize, maxPagesPerTick } = this.options;
    const now = this.options.now ?? Date.now;
    const totals = { received: 0, inserted: 0, skipped: 0, rejected: 0 };
    for (let pageIndex = 0; pageIndex < maxPagesPerTick; pageIndex += 1) {
      const page = await client.popUsageQueue(pageSize);
      totals.received += page.received;
      totals.rejected += page.rejected;
      if (page.records.length > 0) {
        const result = insertUsageEvents(
          db,
          page.records,
          await this.accountLabels(),
          now(),
        );
        totals.inserted += result.inserted;
        totals.skipped += result.skipped;
      }
      if (page.received < pageSize) break;
    }
    return totals;
  }
}
