import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProviderAccountRenameDialog } from './ProviderAccountRenameDialog'

vi.mock('@/i18n/translate', () => ({ t: (key: string) => key }))

describe('account rename dialog', () => {
  it('prefills the name, prevents empty submission and normalizes a valid name', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onClose = vi.fn()
    const account = {
      id: 'id',
      integrationID: 'provider',
      label: 'Original',
      active: true,
      type: 'key' as const,
      methodID: null,
    }
    const { rerender, unmount } = render(
      <ProviderAccountRenameDialog
        account={account}
        pending={false}
        failed={false}
        onSave={onSave}
        onClose={onClose}
      />,
    )
    try {
      const input = screen.getByRole('textbox', { name: 'Account name' })
      expect(input).toHaveValue('Original')
      await user.clear(input)
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
      expect(onSave).not.toHaveBeenCalled()
      await user.type(input, ' New name ')
      await user.click(screen.getByRole('button', { name: 'Save' }))
      expect(onSave).toHaveBeenCalledExactlyOnceWith('New name')
      rerender(
        <ProviderAccountRenameDialog account={account} pending={false} failed onSave={onSave} onClose={onClose} />,
      )
      expect(input).toHaveValue(' New name ')
      expect(screen.getByRole('alert')).toHaveTextContent('Your input has been kept.')
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onClose).toHaveBeenCalledOnce()
      expect(onSave).toHaveBeenCalledOnce()
    } finally {
      unmount()
    }
  })
})
