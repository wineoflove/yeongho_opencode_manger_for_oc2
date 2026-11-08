import { Hono } from "hono";
import { TokenStatsQuerySchema } from "@opencode-manager/shared/schemas";
import {
  aggregateTokenStats,
  type UsageIndexSnapshot,
} from "../services/stats/aggregate";
import type { PriceTable } from "../services/stats/pricing";
import { logger } from "../utils/logger";

export interface TokenStatsSource {
  readonly getSnapshot: () => Promise<UsageIndexSnapshot>;
}

export interface PriceSource {
  readonly getPrices: () => Promise<PriceTable>;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function createStatsRoutes(
  source: TokenStatsSource,
  prices: PriceSource,
  now: () => number = Date.now,
) {
  const app = new Hono();

  app.get("/tokens", async (c) => {
    const filters = c.req.queries("filter") ?? [];
    const parsed = TokenStatsQuerySchema.safeParse({
      from: parseNumber(c.req.query("from")),
      to: parseNumber(c.req.query("to")),
      tzOffsetMinutes: parseNumber(c.req.query("tz")),
      groupBy: c.req.query("groupBy") || undefined,
      splitBy: c.req.query("splitBy") || undefined,
      filters: filters.map((filter) => {
        const separator = filter.indexOf(":");
        return separator < 0
          ? { dimension: filter, value: "" }
          : {
              dimension: filter.slice(0, separator),
              value: filter.slice(separator + 1),
            };
      }),
    });
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid statistics query",
          issues: parsed.error.issues.map((issue) => issue.message),
        },
        400,
      );
    }
    try {
      const [snapshot, priceTable] = await Promise.all([
        source.getSnapshot(),
        prices.getPrices(),
      ]);
      return c.json(
        aggregateTokenStats(snapshot, parsed.data, now(), priceTable),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      logger.error("Failed to compute token statistics", error);
      return c.json({ error: "Failed to compute token statistics" }, 500);
    }
  });

  return app;
}
