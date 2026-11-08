import type { AllowedText } from './core'

export const reposAllowed: readonly AllowedText[] = [
  { file: 'src/components/terminal/TerminalKeyBar.tsx', text: 'esc', reason: 'literal terminal keyboard key label' },
  { file: 'src/components/terminal/TerminalKeyBar.tsx', text: 'tab', reason: 'literal terminal keyboard key label' },
  {
    file: 'src/components/terminal/TerminalKeyBar.tsx',
    text: 'ctrl',
    reason: 'literal terminal keyboard modifier label',
  },
  {
    file: 'src/components/terminal/TerminalKeyBar.tsx',
    text: 'alt',
    reason: 'literal terminal keyboard modifier label',
  },
  {
    file: 'src/components/repo/AddRepoDialog.tsx',
    text: '/absolute/path/to/projects',
    reason: 'path example placeholder',
  },
  {
    file: 'src/components/repo/CreateWorktreeDialog.tsx',
    text: 'feature/my-branch',
    reason: 'git branch name example placeholder',
  },
  {
    file: 'src/components/repo/DirectoryPickerDialog.tsx',
    text: 'git',
    reason: 'Git name badge for git repository folders',
  },
  { file: 'src/components/repo/RepoCard.tsx', text: 'main', reason: 'default git branch name fallback' },
]
