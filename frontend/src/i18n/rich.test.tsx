import { describe, it, expect, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { setLocale } from './locale'
import { tr } from './rich'
import { KO } from './ko'

const KEY = 'Open {link} to continue'

describe('tr', () => {
  afterEach(() => {
    delete KO[KEY]
  })

  it('renders nodes in place of placeholders in en', () => {
    const { container } = render(<p>{tr(KEY, { link: <a href="/x">settings</a> })}</p>)

    expect(container.querySelector('p')?.innerHTML).toBe('Open <a href="/x">settings</a> to continue')
  })

  it('uses the ko template order', () => {
    KO[KEY] = '계속하려면 {link}을 여세요'
    setLocale('ko')

    const { container } = render(<p>{tr(KEY, { link: <strong>설정</strong> })}</p>)

    expect(container.querySelector('p')?.innerHTML).toBe('계속하려면 <strong>설정</strong>을 여세요')
  })

  it('returns keyed fragments and keeps unknown placeholders', () => {
    const nodes = tr('{a} and {b}', { a: 'x' })

    const { container } = render(<p>{nodes}</p>)

    expect(container.textContent).toBe('x and {b}')
    expect(nodes.every((node) => typeof node === 'object' && node !== null && 'key' in node && node.key !== null)).toBe(
      true,
    )
  })
})
