import { z } from "zod";

export const UsageWindowSchema = z.object({
  key: z.enum(["five_hour", "weekly", "seven_day", "seven_day_fable"]),
  label: z.string(),
  usedPercent: z.number().min(0).max(100).optional(),
  remaining: z.number().optional(),
  limit: z.number().optional(),
  resetAt: z.number().int().optional(),
  updatedAt: z.number().int().optional(),
});

export const AccountUsageStateSchema = z.enum([
  "ok",
  "rate-limited",
  "auth-invalid",
  "disabled",
  "awaiting-first-request",
]);

export const UsageConfidenceSchema = z.enum([
  "fresh",
  "stale",
  "error",
  "unknown",
]);

export const AccountUsageSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  accountKey: z.string().min(1),
  label: z.string().min(1),
  email: z.string().optional(),
  planType: z.string().optional(),
  enabled: z.boolean(),
  state: AccountUsageStateSchema,
  confidence: UsageConfidenceSchema,
  windows: z.array(UsageWindowSchema),
  rateLimitedUntil: z.number().int().optional(),
  lastError: z.string().optional(),
  updatedAt: z.number().int().optional(),
});

export const UsageSourceStatusSchema = z.enum([
  "ok",
  "locked",
  "unavailable",
  "error",
]);

export const UsageSourceSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  status: UsageSourceStatusSchema,
  message: z.string().optional(),
  accounts: z.array(AccountUsageSchema),
});

export const AccountUsageResponseSchema = z.object({
  generatedAt: z.number().int(),
  sources: z.array(UsageSourceSchema),
});

export type UsageWindow = z.infer<typeof UsageWindowSchema>;
export type AccountUsageState = z.infer<typeof AccountUsageStateSchema>;
export type UsageConfidence = z.infer<typeof UsageConfidenceSchema>;
export type AccountUsage = z.infer<typeof AccountUsageSchema>;
export type UsageSourceStatus = z.infer<typeof UsageSourceStatusSchema>;
export type UsageSource = z.infer<typeof UsageSourceSchema>;
export type AccountUsageResponse = z.infer<typeof AccountUsageResponseSchema>;
