import type { AllowedText } from './core'

export const settingsIntegrationsAllowed: readonly AllowedText[] = [
  {
    file: 'src/components/settings/OpenCodeModelDialog.tsx',
    text: 'YYYY-MM-DD',
    reason: 'Required date format example',
  },
  {
    file: 'src/components/settings/OpenCodeModelDialog.tsx',
    text: '{\n  "temperature": 1\n}',
    reason: 'Literal model options JSON example',
  },
  {
    file: 'src/components/settings/OpenCodeModelDialog.tsx',
    text: '{\n  "Authorization": "Bearer ..."\n}',
    reason: 'Literal HTTP headers JSON example',
  },
  {
    file: 'src/components/settings/OpenCodeModelDialog.tsx',
    text: '{\n  "reasoning": true\n}',
    reason: 'Literal model capabilities JSON example',
  },
  {
    file: 'src/components/settings/OpenCodeModelDialog.tsx',
    text: '{\n  "input": 0.1,\n  "output": 0.2\n}',
    reason: 'Literal model cost JSON example',
  },
  {
    file: 'src/components/settings/OpenCodeModelDialog.tsx',
    text: '{\n  "fast": {}\n}',
    reason: 'Literal model variants JSON example',
  },
  { file: 'src/components/settings/AgentDialog.tsx', text: 'my-agent', reason: 'Example agent identifier' },
  { file: 'src/components/settings/CommandDialog.tsx', text: 'my-command', reason: 'Example command identifier' },
  { file: 'src/components/settings/CommandDialog.tsx', text: 'build', reason: 'Agent identifier example' },
  {
    file: 'src/components/settings/CommandDialog.tsx',
    text: 'anthropic/claude-3-5-sonnet-20241022',
    reason: 'Provider/model identifier example',
  },
  {
    file: 'src/components/settings/SkillDialog.tsx',
    text: 'my-skill',
    reason: 'Example skill identifier in the required lowercase format',
  },
  {
    file: 'src/components/settings/SkillDialog.tsx',
    text: '## What I do&#10;&#10;- Step 1&#10;- Step 2&#10;&#10;## When to use me&#10;&#10;Use this when...',
    reason: 'Example agent-readable skill body, not translated under task scope',
  },
  {
    file: 'src/components/settings/AddMcpServerDialog.tsx',
    text: 'npx @modelcontextprotocol/server-filesystem /tmp',
    reason: 'Executable command example',
  },
  {
    file: 'src/components/settings/AddMcpServerDialog.tsx',
    text: 'http://localhost:3000/mcp',
    reason: 'Example MCP endpoint URL',
  },
  {
    file: 'src/components/settings/AddMcpServerDialog.tsx',
    text: 'API_KEY',
    reason: 'Example environment variable identifier',
  },
]
