import { createRef, StrictMode, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { resizeTerminal } from '@/api/terminals'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import { setLocale } from '@/i18n/locale'

const xterm = vi.hoisted(() => {
  const onDataHandlers: Array<(data: string) => void> = []
  return {
    onDataHandlers,
    modes: { applicationCursorKeysMode: false },
    write: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
  }
})

const socket = vi.hoisted(() => ({ send: vi.fn(), onExit: undefined as (() => void) | undefined }))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: xterm.write,
    focus: xterm.focus,
    dispose: xterm.dispose,
    onData: (handler: (data: string) => void) => {
      xterm.onDataHandlers.push(handler)
      return { dispose: vi.fn() }
    },
    options: {},
    modes: xterm.modes,
    cols: 80,
    rows: 24,
  })),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: vi.fn() })),
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('@/api/terminals', () => ({
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/terminal-theme', () => ({
  resolveTerminalTheme: vi.fn(() => ({})),
}))

vi.mock('@/hooks/useTerminalSocket', () => ({
  useTerminalSocket: (options: { onExit: () => void }) => {
    socket.onExit = options.onExit
    return { send: socket.send, status: 'open' }
  },
}))

function renderView(overrides: Partial<ComponentProps<typeof TerminalView>> = {}) {
  const ref = createRef<TerminalViewHandle>()
  const onCtrlConsumed = vi.fn()
  const element = (
    <TerminalView
      ref={ref}
      target={{ kind: 'repo', repoId: 1 }}
      directory="/repo"
      ptyID="t1"
      active
      ctrlArmed={false}
      onCtrlConsumed={onCtrlConsumed}
      onOpenLink={vi.fn()}
      onExited={vi.fn()}
      {...overrides}
    />
  )
  const view = render(element)
  return { ref, onCtrlConsumed, view }
}

describe('TerminalView input handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    xterm.onDataHandlers.length = 0
    xterm.modes.applicationCursorKeysMode = false
  })

  it('sends key-bar arrows as CSI normally and as SS3 in application cursor mode', () => {
    const { ref } = renderView()

    act(() => {
      ref.current?.sendArrow('up')
    })
    expect(socket.send).toHaveBeenLastCalledWith('\x1b[A')

    xterm.modes.applicationCursorKeysMode = true
    act(() => {
      ref.current?.sendArrow('left')
    })
    expect(socket.send).toHaveBeenLastCalledWith('\x1bOD')
  })

  it.each([false, true])(
    'applies armed modifiers to key-bar arrows and consumes them before the next character (application mode %s)',
    (applicationMode) => {
      xterm.modes.applicationCursorKeysMode = applicationMode
      const arrow = applicationMode ? '\x1bOA' : '\x1b[A'
      const onAltConsumed = vi.fn()
      const alt = renderView({ altArmed: true, onAltConsumed })
      act(() => {
        alt.ref.current?.sendArrow('up')
        alt.ref.current?.send('c')
      })
      expect(socket.send).toHaveBeenNthCalledWith(1, `\x1b${arrow}`)
      expect(socket.send).toHaveBeenNthCalledWith(2, 'c')
      expect(onAltConsumed).toHaveBeenCalledTimes(1)

      socket.send.mockClear()
      const ctrl = renderView({ ctrlArmed: true })
      act(() => {
        ctrl.ref.current?.sendArrow('up')
        ctrl.ref.current?.send('c')
      })
      expect(socket.send).toHaveBeenNthCalledWith(1, arrow)
      expect(socket.send).toHaveBeenNthCalledWith(2, 'c')
      expect(ctrl.onCtrlConsumed).toHaveBeenCalledTimes(1)
    },
  )

  it('writes a localized notice when the process exits', () => {
    setLocale('ko')
    try {
      const onExited = vi.fn()
      renderView({ onExited })
      act(() => {
        socket.onExit?.()
      })
      expect(xterm.write).toHaveBeenCalledWith('\r\n[프로세스가 종료되었습니다]\r\n')
      expect(onExited).toHaveBeenCalledTimes(1)
    } finally {
      setLocale('en')
    }
  })

  it.each(['ctrl', 'alt'] as const)(
    'does not re-arm a consumed %s modifier when the parent rerenders with the same armed prop',
    (modifier) => {
      const ref = createRef<TerminalViewHandle>()
      const onCtrlConsumed = vi.fn()
      const onAltConsumed = vi.fn()
      const props: ComponentProps<typeof TerminalView> = {
        target: { kind: 'repo', repoId: 1 },
        directory: '/repo',
        ptyID: 't1',
        active: true,
        ctrlArmed: modifier === 'ctrl',
        onCtrlConsumed,
        altArmed: modifier === 'alt',
        onAltConsumed,
        onOpenLink: vi.fn(),
        onExited: vi.fn(),
      }
      const { rerender } = render(<TerminalView ref={ref} {...props} />)
      const consumed = modifier === 'ctrl' ? onCtrlConsumed : onAltConsumed

      act(() => {
        ref.current?.sendArrow('up')
      })
      rerender(<TerminalView ref={ref} {...props} directory="/repo/other" />)
      act(() => {
        ref.current?.send('c')
      })
      expect(socket.send).toHaveBeenLastCalledWith('c')
      expect(consumed).toHaveBeenCalledTimes(1)

      const off = modifier === 'ctrl' ? { ctrlArmed: false } : { altArmed: false }
      const on = modifier === 'ctrl' ? { ctrlArmed: true } : { altArmed: true }
      rerender(<TerminalView ref={ref} {...props} {...off} />)
      rerender(<TerminalView ref={ref} {...props} {...on} />)
      act(() => {
        ref.current?.send('c')
      })
      expect(socket.send).toHaveBeenLastCalledWith(modifier === 'ctrl' ? '\x03' : '\x1bc')
      expect(consumed).toHaveBeenCalledTimes(2)
    },
  )

  it('keeps a consumed modifier disarmed across StrictMode replays and same-value rerenders', () => {
    const ref = createRef<TerminalViewHandle>()
    const onCtrlConsumed = vi.fn()
    const props: ComponentProps<typeof TerminalView> = {
      target: { kind: 'repo', repoId: 1 },
      directory: '/repo',
      ptyID: 't1',
      active: true,
      ctrlArmed: true,
      onCtrlConsumed,
      onOpenLink: vi.fn(),
      onExited: vi.fn(),
    }
    const { rerender } = render(
      <StrictMode>
        <TerminalView ref={ref} {...props} />
      </StrictMode>,
    )

    act(() => {
      ref.current?.send('c')
    })
    rerender(
      <StrictMode>
        <TerminalView ref={ref} {...props} directory="/repo/other" />
      </StrictMode>,
    )
    act(() => {
      ref.current?.send('c')
    })

    expect(socket.send).toHaveBeenNthCalledWith(1, '\x03')
    expect(socket.send).toHaveBeenLastCalledWith('c')
    expect(onCtrlConsumed).toHaveBeenCalledTimes(1)
  })

  it('consumes each one-shot modifier once even when two inputs arrive before a rerender', () => {
    const onAltConsumed = vi.fn()
    const { ref, onCtrlConsumed } = renderView({ ctrlArmed: true, altArmed: true, onAltConsumed })

    act(() => {
      ref.current?.send('x')
      ref.current?.send('x')
    })

    expect(socket.send).toHaveBeenNthCalledWith(1, '\x1b\x18')
    expect(socket.send).toHaveBeenNthCalledWith(2, 'x')
    expect(onCtrlConsumed).toHaveBeenCalledTimes(1)
    expect(onAltConsumed).toHaveBeenCalledTimes(1)
  })

  it('meta-prefixes the next input once while alt is armed and combines it with ctrl', () => {
    const onAltConsumed = vi.fn()
    const { ref } = renderView({ altArmed: true, onAltConsumed })

    act(() => {
      xterm.onDataHandlers[0]('b')
    })
    expect(socket.send).toHaveBeenLastCalledWith('\x1bb')
    expect(onAltConsumed).toHaveBeenCalledTimes(1)

    const combined = renderView({ altArmed: true, ctrlArmed: true, onAltConsumed })
    act(() => {
      combined.ref.current?.send('x')
    })
    expect(socket.send).toHaveBeenLastCalledWith('\x1b\x18')
    expect(ref.current).not.toBeNull()
  })

  it('applies the ctrl modifier and consumes it for imperative key-bar sends', () => {
    const { ref, onCtrlConsumed } = renderView({ ctrlArmed: true })

    act(() => {
      ref.current?.send('c')
    })

    expect(socket.send).toHaveBeenCalledWith('\x03')
    expect(onCtrlConsumed).toHaveBeenCalledTimes(1)
  })

  it('applies the ctrl modifier to keyboard input while armed', () => {
    const { onCtrlConsumed } = renderView({ ctrlArmed: true })

    act(() => {
      xterm.onDataHandlers[0]('c')
    })

    expect(socket.send).toHaveBeenCalledWith('\x03')
    expect(onCtrlConsumed).toHaveBeenCalledTimes(1)
  })

  it('consumes ctrl exactly once so subsequent keyboard input is unmodified', () => {
    const ref = createRef<TerminalViewHandle>()
    const onCtrlConsumed = vi.fn()
    const props: ComponentProps<typeof TerminalView> = {
      target: { kind: 'repo', repoId: 1 },
      directory: '/repo',
      ptyID: 't1',
      active: true,
      ctrlArmed: true,
      onCtrlConsumed,
      onOpenLink: vi.fn(),
      onExited: vi.fn(),
    }

    const { rerender } = render(<TerminalView ref={ref} {...props} />)

    act(() => {
      ref.current?.send('c')
    })
    expect(socket.send).toHaveBeenLastCalledWith('\x03')
    expect(onCtrlConsumed).toHaveBeenCalledTimes(1)

    rerender(<TerminalView ref={ref} {...props} ctrlArmed={false} />)

    act(() => {
      xterm.onDataHandlers[xterm.onDataHandlers.length - 1]('c')
    })

    expect(socket.send).toHaveBeenLastCalledWith('c')
    expect(onCtrlConsumed).toHaveBeenCalledTimes(1)
  })
})

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    TestResizeObserver.instances.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function setVisibleSize(container: HTMLElement) {
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 400, configurable: true })
}

describe('TerminalView resize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    TestResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sends a resize only when the fitted size changes', () => {
    const { view } = renderView()
    const container = view.container.querySelector('[data-terminal-id="t1"]') as HTMLElement
    setVisibleSize(container)

    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(resizeTerminal).toHaveBeenCalledTimes(1)

    act(() => {
      TestResizeObserver.instances[0].trigger()
      vi.advanceTimersByTime(150)
    })
    act(() => {
      TestResizeObserver.instances[0].trigger()
      vi.advanceTimersByTime(150)
    })

    expect(resizeTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not send a resize while the view is hidden', () => {
    const { view } = renderView({ active: false })
    const container = view.container.querySelector('[data-terminal-id="t1"]') as HTMLElement
    setVisibleSize(container)

    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(resizeTerminal).not.toHaveBeenCalled()
  })

  it('does not send a resize when the container has no size', () => {
    renderView()

    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(resizeTerminal).not.toHaveBeenCalled()
  })
})
