import { fetchWrapperBlob } from '@/api/fetchWrapper'
import { showToast } from './toast'
import { t } from '@/i18n/translate'

function isIosHomeScreenApp(): boolean {
  const isIos =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (!isIos) return false

  const isStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  return isStandalone
}

function saveViaAnchor(href: string, filename: string): void {
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

async function saveViaShareSheet(blob: Blob, filename: string): Promise<boolean> {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })

  if (!navigator.canShare?.({ files: [file] })) {
    showToast.error(t('{filename} cannot be saved from this device', { filename }))
    return false
  }

  try {
    await navigator.share({ files: [file] })
    return true
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    if (name === 'AbortError') return false
    if (name === 'NotAllowedError') {
      showToast.info(t('Tap Save to finish saving {filename}', { filename }), {
        action: { label: t('Save'), onClick: () => void saveViaShareSheet(blob, filename) },
      })
      return false
    }
    showToast.error(t('Failed to save {filename}', { filename }))
    return false
  }
}

export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  if (isIosHomeScreenApp()) {
    return saveViaShareSheet(blob, filename)
  }

  const url = URL.createObjectURL(blob)
  saveViaAnchor(url, filename)
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}

export async function saveFileFromUrl(url: string, filename: string): Promise<boolean> {
  if (isIosHomeScreenApp()) {
    try {
      return await saveFile(await fetchWrapperBlob(url), filename)
    } catch {
      showToast.error(t('Failed to save {filename}', { filename }))
      return false
    }
  }

  saveViaAnchor(url, filename)
  return true
}
