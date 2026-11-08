import type { ScheduleUsageTotals } from "@opencode-manager/shared/schemas";
import type { UsageRecord } from "./aggregate";

export interface TokenPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface ModelCost extends TokenPrice {
  readonly tiers: readonly (TokenPrice & { readonly contextAbove: number })[];
}

export type PriceTable = ReadonlyMap<string, ReadonlyMap<string, ModelCost>>;

export interface CostEstimate {
  readonly estimatedCost: number;
  readonly unpricedMessages: number;
}

export interface CatalogModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly cost: readonly {
    readonly tier?: { readonly type: "context"; readonly size: number };
    readonly input: number;
    readonly output: number;
    readonly cache: { readonly read: number; readonly write: number };
  }[];
}

const toPrice = (entry: CatalogModel["cost"][number]): TokenPrice => ({
  input: entry.input,
  output: entry.output,
  cacheRead: entry.cache.read,
  cacheWrite: entry.cache.write,
});

export function buildPriceTable(models: readonly CatalogModel[]): PriceTable {
  const table = new Map<string, Map<string, ModelCost>>();
  for (const model of models) {
    const base = model.cost.find((entry) => entry.tier === undefined);
    if (!base) continue;
    const tiers = model.cost.flatMap((entry) =>
      entry.tier?.type === "context"
        ? [{ ...toPrice(entry), contextAbove: entry.tier.size }]
        : [],
    );
    const provider =
      table.get(model.providerID) ?? new Map<string, ModelCost>();
    provider.set(model.modelID, { ...toPrice(base), tiers });
    table.set(model.providerID, provider);
  }
  return table;
}

export function lookupModelPrice(
  prices: PriceTable,
  providerID: string,
  modelID: string,
): ModelCost | undefined {
  const exact = prices.get(providerID)?.get(modelID);
  if (exact) return exact;
  let match: ModelCost | undefined;
  for (const models of prices.values()) {
    const candidate = models.get(modelID);
    if (!candidate) continue;
    if (
      match &&
      (match.input !== candidate.input || match.output !== candidate.output)
    )
      return undefined;
    match ??= candidate;
  }
  return match;
}

export function estimateRecordCost(
  record: UsageRecord,
  prices: PriceTable,
): CostEstimate {
  return estimateModelCost(record, prices, record.keys);
}

function estimateModelCost(
  record: Omit<ScheduleUsageTotals, "messages">,
  prices: PriceTable,
  keys: { readonly provider: string; readonly model: string },
): CostEstimate {
  const tokens = [
    record.input,
    record.output,
    record.reasoning,
    record.cacheRead,
    record.cacheWrite,
  ];
  if (record.cost !== 0 || !tokens.some((value) => value > 0))
    return { estimatedCost: 0, unpricedMessages: 0 };
  const { provider, model } = keys;
  const cost = lookupModelPrice(
    prices,
    provider,
    model.slice(provider.length + 1),
  );
  if (!cost) return { estimatedCost: 0, unpricedMessages: 1 };
  const context = record.input + record.cacheRead + record.cacheWrite;
  let price: TokenPrice = cost;
  let threshold = -Infinity;
  for (const tier of cost.tiers) {
    if (context > tier.contextAbove && tier.contextAbove > threshold) {
      price = tier;
      threshold = tier.contextAbove;
    }
  }
  return {
    estimatedCost:
      (record.input * price.input +
        (record.output + record.reasoning) * price.output +
        record.cacheRead * price.cacheRead +
        record.cacheWrite * price.cacheWrite) /
      1e6,
    unpricedMessages: 0,
  };
}

/** Estimates the API-rate cost of zero-cost usage grouped by `provider/model` key. */
export function estimateUsageCost(
  byModel: Readonly<Record<string, Omit<ScheduleUsageTotals, "messages">>>,
  prices: PriceTable,
): { estimatedCost: number; unpricedModels: number } {
  let estimatedCost = 0;
  let unpricedModels = 0;
  for (const [model, usage] of Object.entries(byModel)) {
    const provider = model.slice(0, model.indexOf("/"));
    const estimate = estimateModelCost(usage, prices, { provider, model });
    estimatedCost += estimate.estimatedCost;
    unpricedModels += estimate.unpricedMessages;
  }
  return { estimatedCost, unpricedModels };
}

export class ModelPriceCache {
  private prices: PriceTable = new Map();
  private loadedAt = -Infinity;
  private inflight: Promise<PriceTable> | undefined;

  constructor(
    private readonly loadCatalog: () => Promise<readonly CatalogModel[]>,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  getPrices(): Promise<PriceTable> {
    if (this.now() - this.loadedAt < this.ttlMs)
      return Promise.resolve(this.prices);
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(): Promise<PriceTable> {
    try {
      this.prices = buildPriceTable(await this.loadCatalog());
      this.loadedAt = this.now();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    return this.prices;
  }
}
