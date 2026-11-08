import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { FileInfo } from '@/types/files'
import { FileTree } from './FileTree'
import userEvent from '@testing-library/user-event'
import { getLocale, setLocale } from '@/i18n/locale'

const file: FileInfo = {
  name: 'notes.txt',
  path: 'docker/notes.txt',
  isDirectory: false,
  size: 5,
  mimeType: 'text/plain',
  content: '',
  lastModified: new Date('2026-07-28T09:12:40Z'),
}

describe('FileTree row actions', () => {
  it.each([true, false])(
    'shows Korean deletion confirmation without deleting on cancel, directory=%s',
    async (isDirectory) => {
      const previous = getLocale()
      setLocale('ko')
      const user = userEvent.setup()
      const onDelete = vi.fn()
      const { unmount } = render(
        <FileTree
          files={[{ ...file, isDirectory }]}
          onFileSelect={vi.fn()}
          onDirectoryClick={vi.fn()}
          selectedFile={null}
          onDelete={onDelete}
          onRename={vi.fn()}
        />,
      )
      try {
        await user.click(screen.getByRole('button', { name: 'notes.txt 작업' }))
        await user.click(await screen.findByRole('menuitem', { name: '삭제' }))
        expect(
          await screen.findByRole('dialog', {
            name: isDirectory ? '폴더 삭제' : '파일 삭제',
          }),
        ).toBeInTheDocument()
        expect(
          screen.getByText(isDirectory ? '이 폴더를 삭제하시겠습니까?' : '이 파일을 삭제하시겠습니까?'),
        ).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: '취소', exact: true }))
        expect(onDelete).not.toHaveBeenCalled()
      } finally {
        unmount()
        setLocale(previous)
      }
    },
  )
  it('names the per-row actions trigger after the file', () => {
    render(
      <FileTree
        files={[file]}
        onFileSelect={vi.fn()}
        onDirectoryClick={vi.fn()}
        selectedFile={null}
        onDelete={vi.fn()}
        onRename={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Actions for notes.txt' })).toBeInTheDocument()
  })
})
