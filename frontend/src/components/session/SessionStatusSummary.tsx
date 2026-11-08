import { useEffect, useState, type ReactNode } from 'react'
import type { SessionInfo, SessionMessageInfo, VoiceSessionStatus } from '@opencode-manager/shared/opencode'
import { useContextUsage } from '@/hooks/useContextUsage'
import { CONTEXT_USAGE_BG_CLASS, contextUsageTone, formatCompactTokens } from '@/lib/contextUsage'
import { formatCost } from '@/lib/tokenStats'
import { formatCompactDuration } from '@/i18n/format'
import { t } from '@/i18n/translate'
import { cn } from '@/lib/utils'
import { sessionElapsedMs, sessionStatusLabel } from '@/lib/sessionStatusSummary'
import { getTodoProgress, type SessionTodo } from '@/lib/sessionTodos'

const TICK_MS = 1000

export interface SessionStatusSummaryProps {
  sessionId: string
  directory?: string
  session?: SessionInfo
  status: VoiceSessionStatus
  active: boolean
  messages: SessionMessageInfo[]
  hasOlder: boolean
  todos?: SessionTodo[]
}

/** Wall-clock time that advances once per second only while the session is running. */
function useLiveNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [live])
  return now
}

function latestAssistant(messages: SessionMessageInfo[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === 'assistant') return message
  }
  return undefined
}

function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono tabular-nums">{value}</span>
    </div>
  )
}

export function SessionStatusSummary({
  sessionId,
  directory,
  session,
  status,
  active,
  messages,
  hasOlder,
  todos = [],
}: SessionStatusSummaryProps) {
  const now = useLiveNow(active)
  const contextUsage = useContextUsage(sessionId, directory, session?.revert?.messageID)
  const assistant = latestAssistant(messages)
  const agent = assistant?.agent ?? session?.agent
  const model = assistant?.model ?? session?.model
  const messageCount = messages.filter((message) => message.type === 'user' || message.type === 'assistant').length
  const percent = contextUsage?.usagePercentage ?? null
  const todoProgress = getTodoProgress(todos)

  return (
    <section aria-label={t('Session status')} className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{t('Session status')}</span>
      <StatRow
        label={t('Status')}
        value={
          <span className="flex items-center justify-end gap-1.5 font-sans">
            <span
              aria-hidden="true"
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                status === 'retry'
                  ? 'bg-warning'
                  : active || status === 'busy'
                    ? 'bg-primary'
                    : 'bg-muted-foreground/50',
              )}
            />
            {sessionStatusLabel(status, active)}
          </span>
        }
      />
      {session && (
        <StatRow label={t('Duration')} value={formatCompactDuration(sessionElapsedMs(session, active, now))} />
      )}
      <StatRow label={t('Messages')} value={hasOlder ? `${messageCount}+` : messageCount} />
      {todoProgress && (
        <StatRow label={t('Tasks')} value={`${todoProgress.completed}/${todoProgress.total} · ${todoProgress.percent}%`} />
      )}
      {agent && <StatRow label={t('Agent')} value={agent} />}
      {model && (
        <StatRow
          label={t('Model')}
          value={`${model.providerID}/${model.id}${model.variant && model.variant !== 'default' ? ` · ${model.variant}` : ''}`}
        />
      )}
      {session && session.cost > 0 && <StatRow label={t('Cost')} value={formatCost(session.cost)} />}
      {contextUsage && (
        <div className="flex flex-col gap-1">
          <StatRow
            label={t('Context')}
            value={`${formatCompactTokens(contextUsage.totalTokens)}${contextUsage.contextLimit ? ` / ${formatCompactTokens(contextUsage.contextLimit)}` : ''}${percent !== null ? ` · ${percent}%` : ''}`}
          />
          {percent !== null && (
            <div
              role="progressbar"
              aria-label={t('Context')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, percent)}
              className="h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn('h-full rounded-full', CONTEXT_USAGE_BG_CLASS[contextUsageTone(percent)])}
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
          )}
        </div>
      )}
    </section>
  )
}
