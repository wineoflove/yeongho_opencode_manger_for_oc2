import { FileBrowser } from '@/components/file-browser/FileBrowser'
import { Header } from '@/components/ui/header'
import { t } from '@/i18n/translate'

export function Workspace() {
  return (
    <div className="h-screen bg-gradient-to-br from-background via-background to-background flex flex-col">
      <Header>
        <Header.BackButton to="/repos" />
        <Header.Title>{t('Workspace')}</Header.Title>
      </Header>

      <div className="flex-1 overflow-hidden p-4">
        <FileBrowser />
      </div>
    </div>
  )
}