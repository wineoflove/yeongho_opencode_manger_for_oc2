import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { setLocale } from '../../i18n/locale'
import { RepoErrorText } from './RepoErrorText'

afterEach(() => {
  cleanup()
  setLocale('en')
})

it('preserves the exact English error output', () => {
  setLocale('en')
  const message = 'remote rejected refs/heads/feature/raw'

  const { container } = render(<RepoErrorText message={message} />)

  expect(container.textContent).toBe(message)
  expect(container.querySelector('span')).toBeNull()
})

it('shows a Korean explanation while preserving unknown server details', () => {
  setLocale('ko')
  const message = 'remote rejected refs/heads/feature/raw'

  render(<RepoErrorText message={message} />)

  expect(screen.getByText(message)).toHaveClass('text-xs', 'text-muted-foreground')
  expect(screen.getByText(message).parentElement?.textContent).not.toBe(message)
})

it('renders a known translated error without duplicating details', () => {
  setLocale('ko')

  const { container } = render(<RepoErrorText message="Upload failed" />)

  expect(container.textContent).toBe('업로드하지 못했습니다')
  expect(container.querySelector('span')).toBeNull()
})
