import { describe, expect, it } from 'vitest'
import { scanSource } from './scanSource'

describe('scanSource', () => {
  it.each([
    ['<p>Save changes</p>', 'jsx-text'],
    ["<span>{loading ? 'Loading…' : 'Done'}</span>", 'jsx-expr'],
    ['<span>{`${n} tokens`}</span>', 'jsx-expr'],
    ['<p title="Delete" />', 'jsx-attr'],
    ["toast.error('Failed')", 'toast'],
    ["showToast.success('Saved')", 'toast'],
    ["toast('failed', { description: 'details', action: { label: 'retry' } })", 'toast'],
    ["toast.promise(work, { loading: 'loading', success: 'done', error: 'failed' })", 'toast'],
    ["const x = { label: 'Home' }", 'ui-prop'],
    ["new Error('Not found')", 'error-text'],
    ["setError('Audio playback failed')", 'ui-literal'],
    ["z.string().min(2, 'Name must be at least 2 characters')", 'ui-literal'],
    ["const x = { running: 'Running' }", 'ui-literal'],
    ['<InfoHint text="Runs use a fresh worktree" />', 'ui-literal'],
    ['<p message="Session not found" />', 'ui-literal'],
    ["<p emptyTitle={emptyTitle ?? 'No skills available'} />", 'ui-literal'],
    ["const L = t('Home')", 'module-t'],
    ["class Labels { label = t('Home') }", 'module-t'],
    ["import { t as translate } from '@/i18n/translate'; const L = translate('Home')", 'module-t'],
    ['d.toLocaleString()', 'raw-date'],
    ['d.toLocaleTimeString(undefined)', 'raw-date'],
    ["d.toLocaleString('en-US', { month: 'short' })", 'raw-date'],
    ["d.toLocaleDateString('ko-KR')", 'raw-date'],
    ['new Intl.DateTimeFormat(undefined, {})', 'raw-date'],
    ['new Intl.NumberFormat()', 'raw-date'],
    ["new Intl.DateTimeFormat('ko-KR')", 'raw-date'],
    ["format(d, 'MMM d HH:mm')", 'raw-date'],
    ['formatDistanceToNow(d)', 'raw-date'],
    ['cronstrue.toString(expr, { use24HourTimeFormat: true })', 'raw-date'],
  ])('reports %s as %s', (source, kind) => {
    const findings = scanSource('src/example.tsx', source)

    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((finding) => finding.kind === kind)).toBe(true)
  })

  it.each([
    "function render() { return t('Save') }",
    "msg('Home')",
    "import { msg as i18nMsg } from '@/i18n/translate'; i18nMsg('Home')",
    "import { msg as i18nMsg } from '../i18n/translate'; i18nMsg('Home')",
    "throw new Error(msg('Cancelled'))",
    '<code>npm run</code>',
    '<kbd>Press key</kbd>',
    '<pre>Run this</pre>',
    '<p title="MCP" />',
    '<p className="Flex" />',
    '<p variant="Outline" />',
    "cn('Bar')",
    "import x from 'Foo'",
    "export { x } from 'Foo'",
    "require('Foo')",
    "import('Foo')",
    "e.key === 'Enter'",
    "switch(x) { case 'Done': break }",
    "const x = { queryKey: ['Schedules'] }",
    "type T = 'Running'",
    "interface T { state: 'Running' }",
    "enum T { State = 'Running' }",
    '<p>{count}</p>',
    "n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })",
    "n.toLocaleString('en-US')",
    "new Intl.NumberFormat('en-US')",
    "format(d, 'yyyy-MM-dd HH:mm')",
    'format(d, "yyyy \'MMM\'")',
    "format(d, 'MMM', { locale: ko })",
    "cronstrue.toString(expr, { locale: 'ko' })",
    'd.toLocaleString(intlLocale())',
    "const render = () => t('Home')",
    "const x = { headers: { custom: 'Some header' } }",
    "x.includes('Running')",
    "'Running' in x",
    "x['Running']",
    "const x = { 'Running': value }",
    'function A() { return <p title={t("Home")} /> }',
    '<p>{lookup("lowercase")}</p>',
    '<p>Chrome Playwright Bash ID LIVE</p>',
    '<p>Ctrl+K</p>',
    '<p>ArrowUp</p>',
    '<p>{`{name}`}</p>',
    '<p>12 MB</p>',
  ])('ignores %s', (source) => {
    const findings = scanSource('src/example.tsx', source)

    expect(findings).toEqual([])
  })

  it('reports the literal line once using the earliest rule', () => {
    const source = '<p\n title={ready ? "Delete" : "Keep"} />'

    const findings = scanSource('src/example.tsx', source)

    expect(findings).toEqual([
      { file: 'src/example.tsx', line: 2, kind: 'jsx-attr', text: 'Delete' },
      { file: 'src/example.tsx', line: 2, kind: 'jsx-attr', text: 'Keep' },
    ])
  })

  it('parses .ts files without JSX so generics are not text', () => {
    const findings = scanSource(
      'src/lib/run.ts',
      'export const run = <T>(value: T, label: Promise<T>) => value\nconst other = 1',
    )

    expect(findings).toEqual([])
  })

  it('allows raw locale implementations inside i18n', () => {
    const findings = scanSource('src/i18n/format.ts', 'd.toLocaleString()')

    expect(findings).toEqual([])
  })
})
