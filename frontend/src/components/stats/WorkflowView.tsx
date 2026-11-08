import { useState, type ReactNode } from 'react'
import type { WorkflowRange, WorkflowTotals } from '@opencode-manager/shared/schemas'
import { FetchError } from '@/api/fetchWrapper'
import { Button } from '@/components/ui/button'
import { useWorkflowStats } from '@/hooks/useWorkflowStats'
import { useLearningLint } from '@/hooks/useLearningLint'
import { formatDelta, formatShare, formatTokens } from '@/lib/tokenStats'
import { formatNumber } from '@/i18n/format'
import { t } from '@/i18n/translate'
import { WorkflowSessionTimeline } from './WorkflowSessionTimeline'

function WorkflowTable({
  title,
  columns,
  rows,
  footnote,
}: {
  title: string
  columns: readonly string[]
  rows: readonly (readonly ReactNode[])[]
  footnote?: ReactNode
}) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {rows.length ? (
        <table className="w-full table-fixed text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className="break-words pb-2 pr-2 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="break-all py-2 pr-2 align-top tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-muted-foreground">{t('No workflow data in this range.')}</p>
      )}
      {footnote && <div className="mt-3 break-all text-xs text-muted-foreground">{footnote}</div>}
    </section>
  )
}

function WorkflowMetrics({ current, previous }: { current: WorkflowTotals; previous: WorkflowTotals }) {
  const metrics = [
    { label: t('Tool error rate'), value: current.errorRate, before: previous.errorRate, format: formatShare },
    { label: t('Bash failures'), value: current.bashNonzero, before: previous.bashNonzero, format: formatNumber },
    { label: t('Repeated calls'), value: current.repeatedCalls, before: previous.repeatedCalls, format: formatNumber },
    { label: t('Compactions'), value: current.compactions, before: previous.compactions, format: formatNumber },
    {
      label: t('Tokens per user message'),
      value: current.tokensPerUserMessage,
      before: previous.tokensPerUserMessage,
      format: formatTokens,
    },
    {
      label: t('Guard actions'),
      value: current.guardBlocked + current.guardAdjusted,
      before: previous.guardBlocked + previous.guardAdjusted,
      format: formatNumber,
    },
  ]
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {metrics.map(({ label, value, before, format }) => {
        const delta = value !== null && before !== null ? formatDelta(value, before) : null
        return (
          <section key={label} aria-label={label} className="min-w-0 rounded-xl border border-border bg-card p-4">
            <h2 className="min-h-8 text-xs font-medium text-muted-foreground">{label}</h2>
            <p className="mt-2 break-all font-mono text-xl font-semibold tabular-nums">
              {value === null ? t('Not available') : format(value)}
            </p>
            <p className="mt-1 text-xs tabular-nums text-muted-foreground">
              {t('Previous: {value}', { value: before === null ? t('Not available') : format(before) })}
            </p>
            {delta && <p className="mt-1 font-mono text-xs tabular-nums">{delta.text}</p>}
          </section>
        )
      })}
    </div>
  )
}

function LessonStore() {
  const lint = useLearningLint()
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{t('Lesson store')}</h2>
      {lint.isError ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {t('Lint unavailable')}
        </p>
      ) : lint.data ? (
        <>
          <dl className="mb-4 flex flex-wrap gap-6">
            {[
              [t('Verified'), lint.data.counts.verified],
              [t('Pending'), lint.data.counts.pending],
              [t('Superseded'), lint.data.counts.superseded],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-mono text-xl tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <ol className="divide-y divide-border/60">
            {lint.data.violations.slice(0, 20).map((violation, index) => (
              <li key={index} className="break-all py-2 text-xs">
                <span className="font-mono">
                  {violation.file} · {violation.code}
                </span>
                <p className="mt-1 text-muted-foreground">{violation.detail}</p>
              </li>
            ))}
          </ol>
          {lint.data.violations.length === 0 && <p className="text-xs text-muted-foreground">{t('No violations')}</p>}
        </>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('Loading...')}
        </p>
      )}
    </section>
  )
}

export function WorkflowView({ range }: { range: WorkflowRange }) {
  const { data, error, isPending, isFetching, refetch } = useWorkflowStats(range)
  const [session, setSession] = useState({ id: '', revision: 0 })
  const incompatible =
    error instanceof FetchError &&
    error.statusCode === 503 &&
    (error.code === 'WORKFLOW_SOURCE_INCOMPATIBLE' || error.message === 'WORKFLOW_SOURCE_INCOMPATIBLE')
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('Workflow')}</h2>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          {t('Refresh')}
        </Button>
      </div>
      {incompatible ? (
        <p role="alert" className="rounded-xl border border-border p-4 text-sm">
          {t('Workflow data is not compatible with this OpenCode version.')}
        </p>
      ) : error ? (
        <p role="alert" className="text-sm">
          {t('Workflow statistics are unavailable')}
        </p>
      ) : isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('Loading...')}
        </p>
      ) : (
        data && (
          <>
            <WorkflowMetrics {...data.totals} />
            {data.totals.current.toolCalls === 0 &&
              data.totals.current.userMessages === 0 &&
              data.totals.current.inputContextTokens === 0 &&
              data.totals.current.compactions === 0 &&
              data.totals.current.guardBlocked + data.totals.current.guardAdjusted === 0 && (
                <p className="text-sm text-muted-foreground">{t('No workflow data in this range.')}</p>
              )}
            <div className="grid min-w-0 gap-4 lg:grid-cols-2">
              <WorkflowTable
                title={t('Tools')}
                columns={[t('Tool'), t('Calls'), t('Errors'), t('Error rate')]}
                rows={data.tools.map((row) => [
                  row.tool,
                  formatNumber(row.calls),
                  formatNumber(row.errors),
                  formatShare(row.errorRate),
                ])}
              />
              <WorkflowTable
                title={t('Error signatures')}
                columns={[t('Signature'), t('Count'), t('Tools'), t('Lessons')]}
                rows={data.errorSignatures.map((row) => [
                  row.signature,
                  formatNumber(row.count),
                  row.tools.join(', '),
                  row.relatedLessonIds === null
                    ? t('Lookup failed')
                    : row.relatedLessonIds.length
                      ? row.relatedLessonIds.join(', ')
                      : t('No lesson'),
                ])}
              />
              <WorkflowTable
                title={t('Bash commands')}
                columns={[t('Command family'), t('Calls'), t('Failures'), t('Timeouts')]}
                rows={data.bashFamilies.map((row) => [
                  row.family,
                  formatNumber(row.calls),
                  formatNumber(row.nonzero),
                  formatNumber(row.timeouts),
                ])}
              />
              <WorkflowTable
                title={t('MCP servers')}
                columns={[t('Server'), t('Calls'), t('Errors'), t('Status')]}
                rows={data.mcp.map((row) => [
                  row.prefix,
                  formatNumber(row.calls),
                  formatNumber(row.errors),
                  row.status === null ? t('Unknown') : t(row.status),
                ])}
                footnote={t('Status source directory: {directory}', {
                  directory: data.mcpStatusSource ?? t('Unknown'),
                })}
              />
              <WorkflowTable
                title={t('LSP diagnostics')}
                columns={[t('Extension'), t('Calls'), t('Errors'), t('Timeouts')]}
                rows={data.lsp.byExtension.map((row) => [
                  row.extension,
                  formatNumber(row.calls),
                  formatNumber(row.errors),
                  formatNumber(row.timeout),
                ])}
                footnote={
                  <>
                    {t('Timeout ms')}:{' '}
                    {data.lsp.timeoutMs
                      .map((row) => `${formatNumber(row.value)} (${formatNumber(row.count)})`)
                      .join(', ') || t('Not available')}
                  </>
                }
              />
              <WorkflowTable
                title={t('First call size')}
                columns={[t('Agent'), t('Sessions'), t('Median tokens')]}
                rows={data.firstCall.map((row) => [
                  row.agent,
                  formatNumber(row.sessions),
                  formatTokens(row.medianTokens),
                ])}
              />
              <WorkflowTable
                title={t('Session types')}
                columns={[t('Type'), t('Sessions'), t('Calls'), t('Errors')]}
                rows={data.kinds.map((row) => [
                  t(row.kind),
                  formatNumber(row.sessions),
                  formatNumber(row.calls),
                  formatNumber(row.errors),
                ])}
              />
              <WorkflowTable
                title={t('Guards')}
                columns={[t('Guard'), t('Blocked'), t('Adjusted')]}
                rows={data.guards.map((row) => [row.id, formatNumber(row.blocked), formatNumber(row.adjusted)])}
              />
            </div>
            <WorkflowTable
              title={t('Repeated calls')}
              columns={[t('Session ID'), t('Tool'), t('Count'), t('Input preview')]}
              rows={data.repeats.map((row) => [
                <button
                  type="button"
                  className="min-h-11 break-all text-left underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setSession((previous) => ({ id: row.sessionId, revision: previous.revision + 1 }))}
                  title={row.title}
                >
                  {row.sessionId}
                </button>,
                row.tool,
                formatNumber(row.count),
                row.inputPreview,
              ])}
            />
          </>
        )
      )}
      {!incompatible && (
        <>
          <WorkflowSessionTimeline key={session.revision} initialSessionId={session.id} />
          <LessonStore />
        </>
      )}
    </div>
  )
}
