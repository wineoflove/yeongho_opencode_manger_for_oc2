import { fetchWrapper } from "./fetchWrapper";
import { API_BASE_URL } from "@/config";
import { AccountUsageResponseSchema } from "@opencode-manager/shared/schemas";
import type { AccountUsageResponse } from "@opencode-manager/shared/schemas";

/** Reads CLIProxy's passive per-account quota snapshot through the Manager. */
export async function fetchAccountUsage(): Promise<AccountUsageResponse> {
  const response = await fetchWrapper<AccountUsageResponse>(
    `${API_BASE_URL}/api/providers/claude-proxy/usage`,
  );
  return AccountUsageResponseSchema.parse(response);
}
