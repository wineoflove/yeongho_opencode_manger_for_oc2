import { applyConfigCandidate, restoreConfigOriginal } from './config-file-swap'
import type { CutoverStep } from './cutover-step-runner'

type Configuration = {
  readonly name: 'global' | 'assistant' | 'learning-review' | 'learning-applications'
  readonly input: Parameters<typeof applyConfigCandidate>[0]
}

export function configurationCutoverSteps(configurations: readonly Configuration[]): readonly CutoverStep[] {
  return configurations.map(({ name, input }) => ({
    name: `config-${name}`,
    forward: async () => {
      await applyConfigCandidate(input)
    },
    rollback: async () => {
      await restoreConfigOriginal(input)
    },
  }))
}
