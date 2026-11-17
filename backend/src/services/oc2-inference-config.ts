import { selectOc2NativePlugins } from './oc2-native-plugins'
import { prepareOpenAiPoolConfig } from './openai-pool-config'
import { prepareClaudeRoutingConfig } from './claude-routing-config'

export function prepareOc2InferenceConfig(
  nativeConfig: unknown,
  openaiPool: unknown,
  gateway: { readonly baseURL: string; readonly ingressKeyFile: string },
) {
  const selected = selectOc2NativePlugins(nativeConfig)
  const openai = prepareOpenAiPoolConfig(selected.config, openaiPool)
  const text = prepareClaudeRoutingConfig(JSON.stringify(openai.config), gateway.baseURL, gateway.ingressKeyFile)
  return {
    text,
    removedOmoRegistrations: selected.removed.length,
    removedLegacyCodexRegistrations: openai.removedLegacyCodexRegistrations,
    credentialActivationRequired: true,
    autoDiscoveredPluginsExcluded: false,
    runtimeApplied: false,
  }
}
