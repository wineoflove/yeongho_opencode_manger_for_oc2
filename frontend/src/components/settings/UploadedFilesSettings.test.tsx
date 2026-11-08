import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { StoredPromptAttachment } from '@opencode-manager/shared/schemas'
import { setLocale } from '@/i18n/locale'
import { UploadedFilesSettings } from './UploadedFilesSettings'

const mocks = vi.hoisted(() => ({
  listStoredPromptAttachments: vi.fn(),
  deleteStoredPromptAttachment: vi.fn(),
  listRepos: vi.fn(),
}))

vi.mock('@/api/promptAttachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/promptAttachments')>()),
  listStoredPromptAttachments: mocks.listStoredPromptAttachments,
  deleteStoredPromptAttachment: mocks.deleteStoredPromptAttachment,
}))
vi.mock('@/api/repos', () => ({ listRepos: mocks.listRepos }))

const REPORT: StoredPromptAttachment = {
  id: 'file-Ab12Cd',
  filename: '분기 보고서.pdf',
  storedName: 'original.pdf',
  path: '/workspace/repos/.attachments/file-Ab12Cd/original.pdf',
  size: 2 * 1024 * 1024,
  uploadedAt: Date.UTC(2026, 10, 8, 3, 15),
  directory: '/workspace/repos/project/worktrees/feature',
  sessionID: 'ses_report',
  hasMetadata: true,
}

const ASSISTANT_IMAGE: StoredPromptAttachment = {
  ...REPORT,
  id: 'file-Zz99Yy',
  filename: 'screen.png',
  storedName: 'original.png',
  path: '/workspace/repos/.attachments/file-Zz99Yy/original.png',
  size: 1024,
  directory: '/workspace/repos/assistant',
  sessionID: 'ses_assistant',
}

const LEGACY: StoredPromptAttachment = {
  ...REPORT,
  id: 'zip-Lg0001',
  filename: 'original.zip',
  storedName: 'original.zip',
  path: '/workspace/repos/.attachments/zip-Lg0001/original.zip',
  size: 512,
  directory: null,
  sessionID: null,
  hasMetadata: false,
}

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UploadedFilesSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('UploadedFilesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listStoredPromptAttachments.mockResolvedValue({
      entries: [REPORT, ASSISTANT_IMAGE, LEGACY],
      totalBytes: REPORT.size + ASSISTANT_IMAGE.size + LEGACY.size,
    })
    mocks.listRepos.mockResolvedValue([
      { id: 0, fullPath: '/workspace/repos/assistant' },
      { id: 4, fullPath: '/workspace/repos/project' },
      { id: 7, fullPath: '/workspace/repos/project/worktrees/feature' },
    ])
    mocks.deleteStoredPromptAttachment.mockResolvedValue(undefined)
  })

  afterEach(() => {
    setLocale('en')
  })

  it('lists each upload with its size, time, session link and open and download links', async () => {
    renderSettings()

    const rows = await screen.findAllByTestId('uploaded-file-row')
    expect(rows).toHaveLength(3)
    expect(screen.getByTestId('uploaded-files-summary')).toHaveTextContent('3 files · 2.0 MB total')
    const report = within(rows[0]!)
    expect(report.getByText('분기 보고서.pdf')).toBeInTheDocument()
    expect(report.getByText('2.0 MB')).toBeInTheDocument()
    expect(await report.findByRole('link', { name: 'Open session' })).toHaveAttribute(
      'href',
      '/repos/7/sessions/ses_report',
    )
    expect(report.getByRole('link', { name: 'Open 분기 보고서.pdf' })).toHaveAttribute(
      'href',
      '/api/files/attachments/file-Ab12Cd/content',
    )
    expect(report.getByRole('link', { name: 'Open 분기 보고서.pdf' })).toHaveAttribute('rel', 'noopener noreferrer')
    const download = report.getByRole('link', { name: 'Download 분기 보고서.pdf' })
    expect(download).toHaveAttribute('href', '/api/files/attachments/file-Ab12Cd/content?download=1')
    expect(download).toHaveAttribute('download', '분기 보고서.pdf')
    expect(await within(rows[1]!).findByRole('link', { name: 'Open session' })).toHaveAttribute(
      'href',
      '/repos/0/sessions/ses_assistant?assistant=1',
    )
    expect(within(rows[2]!).getByText('Uploaded before session tracking')).toBeInTheDocument()
  })

  it('shows the session id when its directory is not a registered repository', async () => {
    mocks.listStoredPromptAttachments.mockResolvedValue({
      entries: [{ ...REPORT, directory: '/elsewhere/project' }],
      totalBytes: REPORT.size,
    })
    renderSettings()

    expect(await screen.findByText('ses_report')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open session' })).not.toBeInTheDocument()
  })

  it('deletes only after the user confirms that single file', async () => {
    const user = userEvent.setup()
    renderSettings()

    await user.click(await screen.findByRole('button', { name: 'Delete 분기 보고서.pdf' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('분기 보고서.pdf will be permanently deleted from this server.')
    expect(mocks.deleteStoredPromptAttachment).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(mocks.deleteStoredPromptAttachment).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Delete 분기 보고서.pdf' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(mocks.deleteStoredPromptAttachment).toHaveBeenCalledTimes(1))
    expect(mocks.deleteStoredPromptAttachment.mock.calls[0]?.[0]).toBe('file-Ab12Cd')
    await waitFor(() => expect(mocks.listStoredPromptAttachments).toHaveBeenCalledTimes(2))
  })

  it('reports a failed delete with the file name', async () => {
    mocks.deleteStoredPromptAttachment.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    renderSettings()

    await user.click(await screen.findByRole('button', { name: 'Delete screen.png' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('Failed to delete screen.png')).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    mocks.listStoredPromptAttachments.mockResolvedValue({ entries: [], totalBytes: 0 })
    renderSettings()

    expect(await screen.findByText('No uploaded files.')).toBeInTheDocument()
  })

  it('renders in Korean', async () => {
    setLocale('ko')
    renderSettings()

    expect(await screen.findByTestId('uploaded-files-summary')).toHaveTextContent('파일 3개 · 총 2.0 MB')
    expect(screen.getByText('업로드 파일')).toBeInTheDocument()
    expect(screen.getByText('세션 기록 이전 업로드')).toBeInTheDocument()
    expect(await screen.findAllByRole('link', { name: '세션 열기' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: '분기 보고서.pdf 삭제' })).toBeInTheDocument()
  })
})
