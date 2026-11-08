import { vi } from 'vitest'
import type {
  McpStatus,
  OpenCodeApi,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SkillInfo,
} from '@opencode-manager/shared/opencode'

export interface ScheduleApiState {
  sessionID: string
  sessionInfo?: SessionInfo
  sessionError?: Error
  messages: SessionMessageInfo[]
  active: Record<string, { type: 'running' }>
  skills: SkillInfo[]
  agents: string[]
  mcp: Record<string, McpStatus>
  mcpConnectResults: Record<string, McpStatus>
  createError?: Error
  promptError?: Error
  interruptError?: Error
  messageError?: Error
  activeError?: Error
  skillError?: Error
}

export interface ScheduleApiStub {
  api: OpenCodeApi
  state: ScheduleApiState
}

export function createStubScheduleApi(state: Partial<ScheduleApiState> = {}): ScheduleApiStub {
  const resolved: ScheduleApiState = {
    sessionID: 'ses-run-1',
    messages: [],
    active: {},
    skills: [],
    agents: ['build', 'plan'],
    mcp: {},
    mcpConnectResults: {},
    ...state,
  }

  const session = {
    get: vi.fn(async () => {
      if (resolved.sessionError) throw resolved.sessionError
      return (
        resolved.sessionInfo ?? {
          id: resolved.sessionID,
          projectID: 'project-schedule',
          title: 'Scheduled run',
          location: { directory: '/tmp/repo' },
          time: { created: 1, updated: 2 },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        }
      )
    }),
    list: vi.fn(async () => ({ data: [], cursor: {} })),
    create: vi.fn(async () => {
      if (resolved.createError) throw resolved.createError
      return { id: resolved.sessionID }
    }),
    prompt: vi.fn(async (input: { sessionID: string; id?: string | null; text: string }) => {
      if (resolved.promptError) throw resolved.promptError
      return {
        id: input.id ?? 'msg-fixture',
        sessionID: input.sessionID,
        time: { created: Date.now() },
        type: 'user',
        payload: { text: input.text },
        delivery: 'queue',
      }
    }),
    interrupt: vi.fn(async () => {
      if (resolved.interruptError) throw resolved.interruptError
      return { interrupted: true }
    }),
    active: vi.fn(async () => {
      if (resolved.activeError) throw resolved.activeError
      return resolved.active
    }),
  }

  const api = {
    session,
    message: {
      list: vi.fn(async () => {
        if (resolved.messageError) throw resolved.messageError
        return { data: resolved.messages, cursor: {} }
      }),
    },
    skill: {
      list: vi.fn(async () => {
        if (resolved.skillError) throw resolved.skillError
        return { location: { directory: '' }, data: resolved.skills }
      }),
    },
    agent: {
      list: vi.fn(async () => ({
        location: { directory: '' },
        data: resolved.agents.map((id) => ({ id, name: id })),
      })),
    },
    mcp: {
      list: vi.fn(async () => ({
        location: { directory: '' },
        data: Object.entries(resolved.mcp).map(([name, status]) => ({
          name,
          status,
        })),
      })),
      add: vi.fn(async ({ server }: { server: string }) => {
        resolved.mcp[server] = { status: 'pending' }
      }),
      connect: vi.fn(async ({ server }: { server: string }) => {
        resolved.mcp[server] = resolved.mcpConnectResults[server] ?? {
          status: 'connected',
        }
      }),
    },
  }

  return { api: api as unknown as OpenCodeApi, state: resolved }
}

let messageSequence = 0

export function assistantMessage(
  text: string,
  options: {
    completed?: boolean
    error?: string
    content?: SessionMessageAssistant['content']
  } = {},
): SessionMessageInfo {
  messageSequence += 1
  const created = Date.now()

  return {
    id: `msg_assistant_${messageSequence}`,
    type: 'assistant',
    agent: 'build',
    model: { id: 'gpt-5', providerID: 'openai' },
    time: { created, ...(options.completed ? { completed: created } : {}) },
    content: options.content ?? [{ type: 'text', text }],
    ...(options.error ? { error: { type: 'ProviderError', message: options.error } } : {}),
  } as SessionMessageInfo
}

export function skill(id: string): SkillInfo {
  return { id, name: id, path: `/skills/${id}/SKILL.md`, content: '' }
}
