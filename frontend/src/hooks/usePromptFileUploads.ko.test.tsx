import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../i18n/locale'
import { showToast } from '../lib/toast'
import { usePromptFileUploads } from './usePromptFileUploads'

afterEach(() => {
  setLocale('en')
  vi.restoreAllMocks()
})

describe('Korean prompt upload errors', () => {
  it('shows a Korean toast when a binary upload has no session directory', async () => {
    setLocale('ko')
    const errorToast = vi.spyOn(showToast, 'error').mockReturnValue('upload-error')
    const onAttachment = vi.fn()
    const { result } = renderHook(() => usePromptFileUploads({ sessionID: 'fixture' }, onAttachment))

    await act(async () => result.current.addFileAttachments([new File(['PK'], 'archive.zip')]))

    expect(errorToast).toHaveBeenCalledWith('archive.zip 파일을 업로드하려면 세션 디렉터리가 필요합니다')
    expect(onAttachment).not.toHaveBeenCalled()
    expect(result.current.hasPendingUploads()).toBe(false)
  })

  it('preserves the English toast and filename when English is selected', async () => {
    setLocale('en')
    const errorToast = vi.spyOn(showToast, 'error').mockReturnValue('upload-error')
    const { result } = renderHook(() => usePromptFileUploads({ sessionID: 'fixture' }, vi.fn()))

    await act(async () => result.current.addFileAttachments([new File(['PK'], 'archive.zip')]))

    expect(errorToast).toHaveBeenCalledWith('A session directory is required to upload archive.zip')
  })
})
