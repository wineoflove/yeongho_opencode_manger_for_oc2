import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { StoredPromptAttachment } from '@opencode-manager/shared/schemas'
import type { Repo } from '@/api/types'
import { listRepos } from '@/api/repos'
import { storedPromptAttachmentUrl } from '@/api/promptAttachments'
import { useDeleteStoredPromptAttachment, useStoredPromptAttachments } from '@/hooks/useStoredPromptAttachments'
import { formatBytes } from '@/lib/systemStatus'
import { getSessionPath } from '@/lib/navigation'
import { formatDateTime, formatNumber } from '@/i18n/format'
import { t } from '@/i18n/translate'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import {
  AlertCircle,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileImage,
  FileText,
  Loader2,
  Paperclip,
  Trash2,
  type LucideIcon,
} from 'lucide-react'

const META_SEPARATOR = "after:ml-1.5 after:content-['·']"
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar'])
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'csv', 'json', 'log', 'doc', 'docx', 'hwp', 'xls', 'xlsx'])

function iconFor(filename: string): LucideIcon {
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : ''
  if (IMAGE_EXTENSIONS.has(extension)) return FileImage
  if (ARCHIVE_EXTENSIONS.has(extension)) return FileArchive
  if (DOCUMENT_EXTENSIONS.has(extension)) return FileText
  return File
}

function findRepo(repos: readonly Repo[], directory: string): Repo | undefined {
  return repos
    .filter((repo) => directory === repo.fullPath || directory.startsWith(`${repo.fullPath}/`))
    .sort((left, right) => right.fullPath.length - left.fullPath.length)[0]
}

function SessionReference({ entry, repos }: { entry: StoredPromptAttachment; repos: readonly Repo[] }) {
  if (!entry.hasMetadata) return <span>{t('Uploaded before session tracking')}</span>
  if (!entry.sessionID) return <span>{t('No session recorded')}</span>
  const repo = entry.directory ? findRepo(repos, entry.directory) : undefined
  if (!repo) return <span className="font-mono">{entry.sessionID}</span>
  return (
    <Link to={getSessionPath(repo.id, entry.sessionID)} className="text-primary underline-offset-2 hover:underline">
      {t('Open session')}
    </Link>
  )
}

/**
 * Lists files uploaded from prompts and stored on this server. Files are kept until someone deletes
 * them here one at a time; nothing is removed automatically.
 */
export function UploadedFilesSettings() {
  const { data, isLoading, error: loadError } = useStoredPromptAttachments()
  const { data: repos = [] } = useQuery({ queryKey: ['repos'], queryFn: listRepos })
  const remove = useDeleteStoredPromptAttachment()
  const [pendingDelete, setPendingDelete] = useState<StoredPromptAttachment | null>(null)
  const entries = data?.entries ?? []

  const error = loadError
    ? t('Failed to load uploaded files')
    : remove.error
      ? t('Failed to delete {filename}', {
          filename: entries.find((entry) => entry.id === remove.variables)?.filename ?? remove.variables ?? '',
        })
      : null

  const handleConfirmDelete = () => {
    if (!pendingDelete) return
    remove.mutate(pendingDelete.id)
    setPendingDelete(null)
  }

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="pb-2 sm:pb-4">
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
          <Paperclip className="h-4 w-4 sm:h-5 sm:w-5" />
          {t('Uploaded files')}
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          {t('Files attached to sessions are stored on this server. Nothing is deleted automatically.')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 sm:space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          !loadError && <p className="text-xs sm:text-sm text-muted-foreground">{t('No uploaded files.')}</p>
        ) : (
          <>
            <p className="text-xs sm:text-sm text-muted-foreground" data-testid="uploaded-files-summary">
              {t('{count} files · {size} total', {
                count: formatNumber(entries.length),
                size: formatBytes(data?.totalBytes ?? 0),
              })}
            </p>
            <ul className="space-y-2">
              {entries.map((entry) => {
                const Icon = iconFor(entry.filename)
                return (
                  <li
                    key={entry.id}
                    className="flex items-center gap-2 rounded-lg bg-muted p-2.5 sm:gap-3 sm:p-3"
                    data-testid="uploaded-file-row"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={entry.filename}>
                        {entry.filename}
                      </p>
                      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <span className={META_SEPARATOR}>{formatBytes(entry.size)}</span>
                        <time className={META_SEPARATOR} dateTime={new Date(entry.uploadedAt).toISOString()}>
                          {formatDateTime(entry.uploadedAt)}
                        </time>
                        <SessionReference entry={entry} repos={repos} />
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Button asChild variant="ghost" size="icon" className="h-9 w-9">
                        <a
                          href={storedPromptAttachmentUrl(entry.id)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={t('Open {filename}', { filename: entry.filename })}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                      <Button asChild variant="ghost" size="icon" className="h-9 w-9">
                        <a
                          href={storedPromptAttachmentUrl(entry.id, { download: true })}
                          download={entry.filename}
                          aria-label={t('Download {filename}', { filename: entry.filename })}
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        aria-label={t('Delete {filename}', { filename: entry.filename })}
                        onClick={() => setPendingDelete(entry)}
                        disabled={remove.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </CardContent>

      <DeleteDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
        title={t('Delete uploaded file')}
        description={
          pendingDelete
            ? t(
                '{filename} will be permanently deleted from this server. Sessions that referenced it can no longer read it.',
                {
                  filename: pendingDelete.filename,
                },
              )
            : ''
        }
        isDeleting={remove.isPending}
      />
    </Card>
  )
}
