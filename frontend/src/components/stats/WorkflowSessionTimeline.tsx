import { useId, useLayoutEffect, useRef, useState } from 'react'
import { FetchError } from '@/api/fetchWrapper'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkflowSession } from '@/hooks/useWorkflowSession'
import { formatTokens, niceCeiling } from '@/lib/tokenStats'
import { formatDateTime, formatNumber } from '@/i18n/format'
import { tr } from '@/i18n/rich'
import { t } from '@/i18n/translate'

export function WorkflowSessionTimeline({ initialSessionId = '' }: { initialSessionId?: string }) {
  const inputId = useId()
  const errorId = useId()
  const containerRef = useRef<HTMLElement>(null)
  const [chartWidth, setChartWidth] = useState(320)
  useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setChartWidth(Math.max(160, entry.contentRect.width))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [input, setInput] = useState(initialSessionId)
  const [sessionId, setSessionId] = useState(initialSessionId)
  const [invalid, setInvalid] = useState(false)
  const { data, error, isFetching } = useWorkflowSession(sessionId)
  const maximum = niceCeiling(Math.max(0, ...(data?.steps.map((step) => step.contextTokens) ?? [])))
  const slot = (chartWidth - 68) / Math.max(1, data?.steps.length ?? 0)
  const notFound = error instanceof FetchError && error.statusCode === 404
  return (
    <section ref={containerRef} className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{t('Session timeline')}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const next = input.trim()
          const valid = /^ses_[A-Za-z0-9]+$/.test(next)
          setInvalid(!valid)
          if (valid) setSessionId(next)
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className="mb-1 block text-xs text-muted-foreground">
            {tr('Session ID ({prefix})', { prefix: <code className="font-mono">ses_…</code> })}
          </label>
          <Input
            id={inputId}
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              setInvalid(false)
            }}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            className="min-h-11 font-mono"
          />
        </div>
        <Button type="submit" variant="outline" className="min-h-11" disabled={isFetching}>
          {t('Open')}
        </Button>
      </form>
      {invalid && (
        <p id={errorId} role="alert" className="mt-3 text-sm text-red-600 dark:text-red-500">
          {t('Enter a valid session ID starting with ses_.')}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm">
          {notFound ? t('Session not found') : t('Session timeline is unavailable')}
        </p>
      )}
      {isFetching && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {t('Loading...')}
        </p>
      )}
      {data && !error && (
        <div className="mt-4">
          <h3 className="break-words text-sm font-medium">{data.title}</h3>
          <p className="mt-1 break-all text-xs text-muted-foreground">{data.sessionId}</p>
          {data.steps.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{t('No session steps')}</p>
          ) : (
            <>
              <svg
                viewBox={`0 0 ${chartWidth} 240`}
                className="mt-4 w-full"
                role="img"
                aria-label={t('Context tokens by step')}
              >
                {[0, 0.5, 1].map((fraction) => (
                  <g key={fraction}>
                    <line
                      x1="60"
                      x2={chartWidth - 8}
                      y1={210 - fraction * 180}
                      y2={210 - fraction * 180}
                      stroke="var(--color-chart-grid)"
                    />
                    <text
                      x="52"
                      y={214 - fraction * 180}
                      textAnchor="end"
                      className="fill-muted-foreground font-mono text-xs"
                    >
                      {formatTokens(maximum * fraction)}
                    </text>
                  </g>
                ))}
                {data.steps.map((step, index) => {
                  const center = 60 + slot * (index + 0.5)
                  const height = (step.contextTokens / maximum) * 180
                  return (
                    <g key={`${step.messageId}-${index}`}>
                      <rect
                        data-testid="context-bar"
                        x={center - slot * 0.34}
                        y={210 - height}
                        width={slot * 0.68}
                        height={height}
                        rx="1"
                        fill="var(--color-chart-1)"
                      >
                        <title>
                          {t('Context tokens')}: {formatNumber(step.contextTokens)}
                        </title>
                      </rect>
                      {step.toolErrors > 0 && (
                        <circle data-testid="tool-error-marker" cx={center} cy="14" r="4" className="fill-red-500">
                          <title>
                            {t('Tool error')}: {formatNumber(step.toolErrors)}
                          </title>
                        </circle>
                      )}
                      {step.guardEvents > 0 && (
                        <circle data-testid="guard-marker" cx={center} cy="226" r="4" className="fill-orange-500">
                          <title>
                            {t('Guard')}: {formatNumber(step.guardEvents)}
                          </title>
                        </circle>
                      )}
                    </g>
                  )
                })}
                {data.compactions.map((compaction, index) => {
                  const matching = data.steps.findIndex((step) => step.messageId === compaction.messageId)
                  const following = data.steps.findIndex((step) => step.at >= compaction.at)
                  const position = matching >= 0 ? matching : following >= 0 ? following : data.steps.length - 1
                  const center = 60 + slot * (position + 0.5)
                  return (
                    <line
                      key={`${compaction.messageId}-${index}`}
                      data-testid="compaction-marker"
                      x1={center}
                      x2={center}
                      y1="24"
                      y2="214"
                      stroke="var(--color-foreground)"
                      strokeDasharray="4 4"
                    >
                      <title>
                        {t('Compaction')}: {formatDateTime(compaction.at)}
                      </title>
                    </line>
                  )
                })}
              </svg>
              <div className="my-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-3 w-3 rounded-sm bg-chart-1" />
                  {t('Context tokens')}
                </span>
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-red-500" />
                  {t('Tool error')}
                </span>
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-3 border-l border-dashed border-foreground" />
                  {t('Compaction')}
                </span>
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-2 w-2 rounded-full bg-orange-500" />
                  {t('Guard')}
                </span>
              </div>
              <dl className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {data.compactions.map((compaction, index) => (
                  <div key={`${compaction.messageId}-${index}`} className="flex gap-2">
                    <dt>{t('Compaction')}</dt>
                    <dd>
                      <time dateTime={new Date(compaction.at).toISOString()}>{formatDateTime(compaction.at)}</time>
                    </dd>
                  </div>
                ))}
              </dl>
              <ol className="max-h-96 overflow-y-auto divide-y divide-border/60">
                {data.steps.map((step, index) => (
                  <li key={`${step.messageId}-${index}`} className="grid gap-1 py-3 text-xs sm:grid-cols-2">
                    <div>
                      <time className="tabular-nums" dateTime={new Date(step.at).toISOString()}>
                        {formatDateTime(step.at)}
                      </time>
                      <p className="mt-1 break-all text-muted-foreground">
                        {step.agent ?? t('Unknown')} · {step.model ?? t('Unknown')}
                      </p>
                    </div>
                    <div className="tabular-nums sm:text-right">
                      <p>
                        {t('Context tokens')}: {formatNumber(step.contextTokens)} · {t('Output tokens')}:{' '}
                        {formatNumber(step.outputTokens)}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        {t('Tool error')}: {formatNumber(step.toolErrors)} · {t('Guard')}:{' '}
                        {formatNumber(step.guardEvents)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  )
}
