import { isAbsolute } from "node:path";
import { ClaudeCompression } from "./claude-compression";
import { ClaudeProxyGate } from "./claude-proxy-gate";
import { ClaudeProxyTransport } from "./claude-proxy-transport";
import {
  ClaudeProxyConfigError,
  readPrivateProxyKey,
} from "./claude-proxy-config";
import type { ClaudeInferenceBinding } from "../routes/claude-inference";

export async function loadClaudeInference(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<ClaudeInferenceBinding | undefined> {
  const incomingFile = environment.OCM_CLAUDE_INFERENCE_KEY_FILE;
  const upstreamFile = environment.OCM_CLAUDE_PROXY_API_KEY_FILE;
  const stateDirectory = environment.OCM_CLAUDE_PROXY_GATE_DIRECTORY;
  if (
    incomingFile === undefined &&
    upstreamFile === undefined &&
    stateDirectory === undefined
  )
    return undefined;
  const baseUrl = environment.OCM_CLAUDE_PROXY_URL;
  const managementFile = environment.OCM_CLAUDE_PROXY_MANAGEMENT_KEY_FILE;
  if (
    !incomingFile ||
    !upstreamFile ||
    !stateDirectory ||
    !isAbsolute(stateDirectory) ||
    !baseUrl ||
    !managementFile
  )
    throw new ClaudeProxyConfigError("INVALID_CONFIGURATION");
  const key = await readPrivateProxyKey(incomingFile);
  const apiKey = await readPrivateProxyKey(upstreamFile);
  const managementKey = await readPrivateProxyKey(managementFile);
  if (new Set([key, apiKey, managementKey]).size !== 3)
    throw new ClaudeProxyConfigError("INVALID_CONFIGURATION");
  const inferenceUrl = environment.OCM_CLAUDE_INFERENCE_UPSTREAM_URL ?? baseUrl;
  if (
    inferenceUrl !== baseUrl &&
    environment.OCM_CLAUDE_COMPRESSION_URL !== undefined
  )
    throw new ClaudeProxyConfigError("INVALID_CONFIGURATION");
  return {
    key,
    transport: new ClaudeProxyTransport(new ClaudeProxyGate(stateDirectory), {
      baseUrl: inferenceUrl,
      apiKey,
      compression:
        environment.OCM_CLAUDE_COMPRESSION_URL === undefined
          ? undefined
          : new ClaudeCompression(environment.OCM_CLAUDE_COMPRESSION_URL),
    }),
  };
}
