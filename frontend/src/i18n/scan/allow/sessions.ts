import type { AllowedText } from './core'

export const sessionsAllowed: readonly AllowedText[] = [
  {
    file: 'src/components/message/FileToolRender.tsx',
    text: 'Edit',
    reason: 'Tool name used for rendering and tool identity comparisons; names are not translated.',
  },
  {
    file: 'src/components/message/FileToolRender.tsx',
    text: 'Write',
    reason: 'Tool name used for rendering and tool identity comparisons; names are not translated.',
  },
  {
    file: 'src/components/message/FileToolRender.tsx',
    text: 'Read',
    reason: 'Tool name used for rendering and tool identity comparisons; names are not translated.',
  },
]
