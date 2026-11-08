import type { AllowedText } from './core'

export const schedulesAllowed: readonly AllowedText[] = [
  {
    file: 'src/components/schedules/GeneralTab.tsx',
    text: 'rm -rf *',
    reason: 'Literal bash deny-pattern example, not interface prose.',
  },
  {
    file: 'src/components/schedules/PromptTab.tsx',
    text: 'Review the repo, summarize notable risks, and open a session I can inspect later.',
    reason: 'Example agent prompt body remains in its original language.',
  },
  { file: 'src/lib/schedules/markdownTemplate.ts', text: 'title', reason: 'Markdown frontmatter field name.' },
  { file: 'src/lib/schedules/markdownTemplate.ts', text: 'description', reason: 'Markdown frontmatter field name.' },
  {
    file: 'src/lib/schedules/markdownTemplate.ts',
    text: 'Imported template',
    reason: 'Persisted template content fallback; template contents are not translated.',
  },
]
