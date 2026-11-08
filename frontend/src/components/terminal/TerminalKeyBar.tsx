import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { msg, t } from '@/i18n/translate'
import type { ArrowDirection } from '@/lib/terminal-protocol'

interface TerminalKeyBarProps {
  onSend: (data: string) => void
  onArrow: (direction: ArrowDirection) => void
  ctrlArmed: boolean
  onToggleCtrl: () => void
  altArmed: boolean
  onToggleAlt: () => void
}

interface SpecialKey {
  label: string
  data: string
  ariaLabel?: string
}

const ESCAPE_KEY = '\x1b'
const TAB_KEY = '\t'

const ARROW_KEYS: Array<{ label: string; direction: ArrowDirection; ariaLabel: string }> = [
  { label: '↑', direction: 'up', ariaLabel: msg('Arrow up') },
  { label: '↓', direction: 'down', ariaLabel: msg('Arrow down') },
  { label: '←', direction: 'left', ariaLabel: msg('Arrow left') },
  { label: '→', direction: 'right', ariaLabel: msg('Arrow right') },
]

const SYMBOL_KEYS: SpecialKey[] = [
  { label: '|', data: '|' },
  { label: '~', data: '~' },
  { label: '/', data: '/' },
]

const KEY_CLASS_NAME = 'h-11 flex-1 px-2 font-mono text-sm'

export function TerminalKeyBar({
  onSend,
  onArrow,
  ctrlArmed,
  onToggleCtrl,
  altArmed,
  onToggleAlt,
}: TerminalKeyBarProps) {
  const renderModifier = (label: string, ariaLabel: string, armed: boolean, onToggle: () => void) => (
    <Button
      type="button"
      variant={armed ? 'default' : 'ghost'}
      size="sm"
      className={cn(KEY_CLASS_NAME, armed && 'bg-primary text-primary-foreground')}
      aria-label={t(ariaLabel)}
      aria-pressed={armed}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
    >
      {label}
    </Button>
  )

  const renderKey = (key: SpecialKey) => (
    <Button
      key={key.label}
      type="button"
      variant="ghost"
      size="sm"
      className={KEY_CLASS_NAME}
      aria-label={key.ariaLabel ? t(key.ariaLabel) : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSend(key.data)}
    >
      {key.label}
    </Button>
  )

  return (
    <div
      className="flex flex-shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-card p-1"
      data-testid="terminal-key-bar"
    >
      {renderKey({ label: 'Esc', data: ESCAPE_KEY })}
      {renderKey({ label: 'Tab', data: TAB_KEY })}
      {renderModifier('Ctrl', msg('Control modifier'), ctrlArmed, onToggleCtrl)}
      {renderModifier('Alt', msg('Alt modifier'), altArmed, onToggleAlt)}
      {ARROW_KEYS.map((key) => (
        <Button
          key={key.label}
          type="button"
          variant="ghost"
          size="sm"
          className={KEY_CLASS_NAME}
          aria-label={t(key.ariaLabel)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onArrow(key.direction)}
        >
          {key.label}
        </Button>
      ))}
      {SYMBOL_KEYS.map(renderKey)}
    </div>
  )
}
