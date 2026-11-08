import {
  Bug,
  CheckCircle2,
  FlaskConical,
  Hammer,
  Play,
  Rocket,
  Server,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import type { ProjectActionIcon } from '@opencode-manager/shared/types'
import { msg } from '@/i18n/translate'

export const ACTION_ICON_OPTIONS: { value: ProjectActionIcon; label: string; Icon: LucideIcon }[] = [
  { value: 'play', label: msg('Play'), Icon: Play },
  { value: 'build', label: msg('Build'), Icon: Hammer },
  { value: 'test', label: msg('Test'), Icon: FlaskConical },
  { value: 'lint', label: msg('Lint'), Icon: CheckCircle2 },
  { value: 'terminal', label: msg('Terminal'), Icon: SquareTerminal },
  { value: 'server', label: msg('Server'), Icon: Server },
  { value: 'bug', label: msg('Bug'), Icon: Bug },
  { value: 'rocket', label: msg('Rocket'), Icon: Rocket },
]

export function actionIcon(icon: ProjectActionIcon | undefined): LucideIcon {
  return ACTION_ICON_OPTIONS.find((option) => option.value === icon)?.Icon ?? Play
}
