import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, Link, RouterProvider } from 'react-router-dom'
import { FileNavigationGuard } from './FileNavigationGuard'
import { FilePreview } from './FilePreview'

const file = {
  name: 'example.txt',
  path: 'example.txt',
  size: 7,
  isDirectory: false,
  content: 'aW5pdGlhbA==',
  mimeType: 'text/plain',
  lastModified: new Date(0),
}

function mount() {
  const router = createMemoryRouter(
    [
      { path: '/away', element: <h1>Destination</h1> },
      {
        path: '/files',
        element: (
          <>
            <FileNavigationGuard />
            <Link to="/away">Leave files</Link>
            <FilePreview file={file} />
          </>
        ),
      },
    ],
    { initialEntries: ['/away', '/files'], initialIndex: 1 },
  )
  render(<RouterProvider router={router} />)
  return router
}

beforeEach(() => {
  vi.stubGlobal(
    'Request',
    class extends Request {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: undefined })
      }
    },
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('file editing navigation protection', () => {
  it('keeps actual editor content when a route departure is cancelled', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved draft' } })
    fireEvent.click(screen.getByRole('link', { name: 'Leave files' }))
    expect(await screen.findByRole('dialog', { name: 'Unsaved Changes' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }))
    expect(screen.getByRole('textbox')).toHaveValue('unsaved draft')
    expect(screen.queryByRole('heading', { name: 'Destination' })).not.toBeInTheDocument()
  })

  it('blocks browser Back until the user explicitly discards editing content', async () => {
    const router = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unsaved draft' } })
    await act(async () => {
      await router.navigate(-1)
    })
    expect(await screen.findByRole('dialog', { name: 'Unsaved Changes' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByRole('heading', { name: 'Destination' })).toBeVisible()
  })

  it('allows navigation once the file has been saved', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'saved text' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    })
    fireEvent.click(screen.getByRole('link', { name: 'Leave files' }))
    expect(await screen.findByRole('heading', { name: 'Destination' })).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('requests browser unload protection while editing', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Edit file' }))
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})
