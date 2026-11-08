import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getRelativePath } from './FileToolRender'
import { TRANSCRIPT_DETAIL_CLASS, TRANSCRIPT_ROW_CLASS } from './transcriptStyles'
import { t, tn } from '@/i18n/translate'

interface StepFileChangesProps {
  files: string[]
  snapshot?: string
  onFileClick?: (filePath: string) => void
}

const INITIAL_FILES_SHOWN = 3

export function StepFileChanges({ files, snapshot, onFileClick }: StepFileChangesProps) {
  const [expanded, setExpanded] = useState(false)

  if (files.length === 0) return null

  const hasMoreFiles = files.length > INITIAL_FILES_SHOWN
  const displayedFiles = expanded ? files : files.slice(0, INITIAL_FILES_SHOWN)
  const hiddenCount = files.length - INITIAL_FILES_SHOWN

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => hasMoreFiles && setExpanded(!expanded)}
        className={cn(TRANSCRIPT_ROW_CLASS, 'hover:text-foreground transition-colors')}
      >
        <span aria-hidden="true">±</span>
        <span className="font-medium text-foreground">
          {tn('File Changes ({count} file)', 'File Changes ({count} files)', files.length)}
        </span>
        <span className="ml-auto flex flex-shrink-0 items-center gap-2">
          {snapshot && <span className="text-xs text-muted-foreground">{snapshot.slice(0, 8)}</span>}
          {hasMoreFiles && (expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />)}
        </span>
      </button>

      <div className={cn(TRANSCRIPT_DETAIL_CLASS, 'space-y-0.5')}>
        {displayedFiles.map((file) => (
          <button
            key={file}
            type="button"
            title={file}
            onClick={() => onFileClick?.(file)}
            className="block max-w-full truncate text-left text-xs font-mono text-primary hover:underline cursor-pointer"
          >
            {getRelativePath(file)}
          </button>
        ))}

        {hasMoreFiles && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {expanded ? t('Show less') : tn('+{count} more file', '+{count} more files', hiddenCount)}
          </button>
        )}
      </div>
    </div>
  )
}
