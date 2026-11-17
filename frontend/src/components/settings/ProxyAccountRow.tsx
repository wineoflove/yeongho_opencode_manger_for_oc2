import { Trash2 } from 'lucide-react'
import type { ClaudeProxyAccount } from '@/api/claudeProxy'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { formatMonthDayTime, formatNumber, formatTime } from '@/i18n/format'
import { msg, t } from '@/i18n/translate'
import { cn } from '@/lib/utils'

type AccountState = 'available' | 'waiting' | 'off'

const states: Readonly<Record<AccountState, { readonly label: string; readonly tone: string; readonly dot: string }>> =
  {
    available: {
      label: msg('Available'),
      tone: 'bg-success/10 text-foreground',
      dot: 'bg-success',
    },
    waiting: {
      label: msg('Temporarily unavailable'),
      tone: 'bg-warning/10 text-foreground',
      dot: 'bg-warning',
    },
    off: {
      label: msg('Inactive'),
      tone: 'bg-muted text-muted-foreground',
      dot: 'bg-muted-foreground',
    },
  }

function accountState(account: ClaudeProxyAccount): AccountState {
  if (!account.enabled) return 'off'
  return account.available ? 'available' : 'waiting'
}

function retryTime(at: number): string {
  return new Date(at).toDateString() === new Date().toDateString() ? formatTime(at) : formatMonthDayTime(at)
}

interface ProxyAccountRowProps {
  readonly account: ClaudeProxyAccount
  readonly name: string
  readonly checked: boolean
  readonly busy: boolean
  readonly onCheckedChange: (enabled: boolean) => void
  readonly onDelete: () => void
}

/** One CLIProxy account with its rotation status, request counts, on/off switch and delete action. */
export function ProxyAccountRow({ account, name, checked, busy, onCheckedChange, onDelete }: ProxyAccountRowProps) {
  const state = states[accountState(account)]
  const retryAt = account.enabled && !account.available && account.nextRetryAt ? Date.parse(account.nextRetryAt) : null
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="break-all text-sm font-medium text-foreground">{name}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', state.tone)}
          >
            <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', state.dot)} />
            {t(state.label)}
          </span>
          {retryAt !== null && retryAt > Date.now() && (
            <span className="text-xs text-muted-foreground">
              {t('Next retry: {time}', { time: retryTime(retryAt) })}
            </span>
          )}
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">
          {t('{success} succeeded · {failure} failed', {
            success: formatNumber(account.successCount),
            failure: formatNumber(account.failureCount),
          })}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={busy}
        onCheckedChange={onCheckedChange}
        aria-label={t('Include {name} in rotation', { name })}
        className="relative after:absolute after:-inset-x-2 after:-inset-y-2.5 after:content-['']"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={busy}
        aria-label={t('Delete {name}', { name })}
        onClick={onDelete}
        className="size-11 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  )
}
