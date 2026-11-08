import type { AllowedText } from './core'

export const messagesAllowed: readonly AllowedText[] = [
  {
    file: 'src/hooks/useServerHealth.ts',
    text: 'ko',
    reason: 'Locale discriminator controlling raw server-error presentation, not displayed text.',
  },
  {
    file: 'src/contexts/EventContext.tsx',
    text: 'Failed to fetch pending actions for ',
    reason: 'Console diagnostic, not user-facing UI copy.',
  },
  {
    file: 'src/contexts/EventContext.tsx',
    text: 'Failed to sync session activity for ',
    reason: 'Console diagnostic, not user-facing UI copy.',
  },
  {
    file: 'src/hooks/useModelSelection.ts',
    text: 'Failed to sync recent model to backend',
    reason: 'Console diagnostic, not user-facing UI copy.',
  },
  {
    file: 'src/hooks/useModelSelection.ts',
    text: 'Failed to toggle favorite model on backend',
    reason: 'Console diagnostic, not user-facing UI copy.',
  },
  {
    file: 'src/hooks/useModelSelection.ts',
    text: 'Failed to remove recent model on backend',
    reason: 'Console diagnostic, not user-facing UI copy.',
  },
  {
    file: 'src/api/opencode.ts',
    text: 'Untitled Session',
    reason: 'Session data fallback; session titles remain unchanged across locales.',
  },
  { file: 'src/api/repos.ts', text: 'GitAuthError', reason: 'Runtime error class identifier, not UI text.' },
  {
    file: 'src/hooks/useOpenCode.ts',
    text: 'MessageAbortedError',
    reason: 'OpenCode protocol error discriminator; comparisons must remain unchanged.',
  },
  {
    file: 'src/hooks/useOpenCode.ts',
    text: 'Loading skill: ',
    reason: 'Optimistic conversation message content remains unchanged, like server messages.',
  },
  {
    file: 'src/hooks/useSSE.ts',
    text: 'compact-',
    reason: 'Toast identifier prefix used for dismissing a pending toast, not displayed copy.',
  },
  {
    file: 'src/lib/exportSession.ts',
    text: 'new Date(timestamp).toLocaleString()',
    reason: 'Exported file content, including dates, must remain unchanged across locales.',
  },
  { file: 'src/lib/exportSession.ts', text: 'Unknown Tool', reason: 'Exported file content must remain unchanged.' },
  {
    file: 'src/lib/exportSession.ts',
    text: 'Untitled Session',
    reason: 'Exported file content must remain unchanged.',
  },
  { file: 'src/lib/exportSession.ts', text: 'User', reason: 'Exported file content must remain unchanged.' },
  { file: 'src/lib/exportSession.ts', text: 'Assistant', reason: 'Exported file content must remain unchanged.' },
]
