import type { AllowedText } from './core'

export const settingsAllowed: readonly AllowedText[] = [
  {
    file: 'src/components/settings/GeneralSettings.tsx',
    text: '한국어',
    reason: 'language names are shown in their own language',
  },
  {
    file: 'src/components/settings/GeneralSettings.tsx',
    text: 'English',
    reason: 'language names are shown in their own language',
  },
  {
    file: 'src/components/settings/GitCredentialDialog.tsx',
    text: 'PAT',
    reason: 'Authentication protocol abbreviation',
  },
  { file: 'src/components/settings/GitCredentialDialog.tsx', text: 'github.com', reason: 'Example hostname' },
  {
    file: 'src/components/settings/GitCredentialDialog.tsx',
    text: '-----BEGIN OPENSSH PRIVATE KEY-----',
    reason: 'Literal SSH key format example',
  },
  { file: 'src/components/settings/GitSettings.tsx', text: 'you@example.com', reason: 'Example email address' },
  { file: 'src/components/settings/GitSettings.tsx', text: 'PAT', reason: 'Authentication protocol abbreviation' },
  {
    file: 'src/components/settings/KeyboardShortcuts.tsx',
    text: 'Space',
    reason: 'Keyboard key name must remain unchanged',
  },
  {
    file: 'src/components/settings/KeyboardShortcuts.tsx',
    text: 'Up',
    reason: 'Keyboard key name must remain unchanged',
  },
  {
    file: 'src/components/settings/KeyboardShortcuts.tsx',
    text: 'Down',
    reason: 'Keyboard key name must remain unchanged',
  },
  {
    file: 'src/components/settings/KeyboardShortcuts.tsx',
    text: 'Left',
    reason: 'Keyboard key name must remain unchanged',
  },
  {
    file: 'src/components/settings/KeyboardShortcuts.tsx',
    text: 'Right',
    reason: 'Keyboard key name must remain unchanged',
  },
  {
    file: 'src/components/settings/KeyboardShortcuts.tsx',
    text: 'Return',
    reason: 'Keyboard key name must remain unchanged',
  },
  {
    file: 'src/components/settings/KeyboardShortcuts.tsx',
    text: 'Delete',
    reason: 'Keyboard key name must remain unchanged',
  },
  { file: 'src/components/settings/STTSettings.tsx', text: 'https://api.openai.com', reason: 'Example API endpoint' },
  { file: 'src/components/settings/STTSettings.tsx', text: 'sk-...', reason: 'Example API key format' },
  { file: 'src/components/settings/SandboxSettings.tsx', text: 'msb', reason: 'Sandbox product name' },
  {
    file: 'src/components/settings/ServerEnvVarsSettings.tsx',
    text: 'VARIABLE_NAME',
    reason: 'Environment variable identifier example',
  },
  {
    file: 'src/components/settings/ServerHealthStatus.tsx',
    text: 'OpenCode v',
    reason: 'Product name and version prefix',
  },
  {
    file: 'src/components/settings/TTSSettings.tsx',
    text: 'Text to speech is working correctly.',
    reason: 'Fixed speech engine test input, not a UI label',
  },
  { file: 'src/components/settings/TTSSettings.tsx', text: 'https://api.openai.com', reason: 'Example API endpoint' },
  { file: 'src/components/settings/TTSSettings.tsx', text: 'sk-...', reason: 'Example API key format' },
  {
    file: 'src/components/settings/VersionSelectDialog.tsx',
    text: 'install-version',
    reason: 'Toast identifier, not display text',
  },
]
