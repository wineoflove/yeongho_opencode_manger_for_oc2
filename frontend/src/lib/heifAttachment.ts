import { msg } from '@/i18n/translate'

export const isHeifAttachment = (file: Pick<File, 'name' | 'type'>): boolean =>
  /^image\/hei[cf](?:-sequence)?$/i.test(file.type) ||
  ((!file.type || file.type === 'application/octet-stream') && /\.hei[cf]$/i.test(file.name))

let conversionQueue: Promise<void> = Promise.resolve()

export async function convertHeifAttachment(file: File): Promise<File> {
  const previous = conversionQueue
  let release = () => {}
  conversionQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    const { heicTo } = await import('heic-to/csp')
    const bitmap = await heicTo({ blob: file, type: 'bitmap' })
    const canvas = document.createElement('canvas')
    try {
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error(msg('HEIF conversion failed. Please attach a JPEG or PNG image.'))
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      if (!jpeg || jpeg.type !== 'image/jpeg' || jpeg.size > 4 * 1024 * 1024)
        throw new Error(msg('HEIF conversion failed. Please attach a JPEG or PNG image.'))
      const filename = /\.hei[cf]$/i.test(file.name) ? file.name.replace(/\.hei[cf]$/i, '.jpg') : `${file.name}.jpg`
      return new File([jpeg], filename, { type: 'image/jpeg' })
    } finally {
      bitmap.close()
      canvas.width = 0
      canvas.height = 0
    }
  } finally {
    release()
  }
}
