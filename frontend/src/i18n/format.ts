import { format, formatDistanceToNow } from 'date-fns'
import { enUS, ko } from 'date-fns/locale'
import { getLocale } from './locale'

export type DateInput = Date | number | string

type IntlLocale = 'ko-KR' | 'en-US'

export function intlLocale(): IntlLocale {
  return getLocale() === 'ko' ? 'ko-KR' : 'en-US'
}

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

const dateTimeFormats = new Map<string, Intl.DateTimeFormat>()
const numberFormats = new Map<string, Intl.NumberFormat>()

function cachedFormat<T>(cache: Map<string, T>, options: object | undefined, create: (locale: IntlLocale) => T): T {
  const locale = intlLocale()
  const key = `${locale}|${JSON.stringify(options ?? {})}`
  let formatter = cache.get(key)
  if (!formatter) {
    formatter = create(locale)
    cache.set(key, formatter)
  }
  return formatter
}

function formatWith(value: DateInput, options: Intl.DateTimeFormatOptions): string {
  return cachedFormat(dateTimeFormats, options, (locale) => new Intl.DateTimeFormat(locale, options)).format(
    toDate(value),
  )
}

export function formatDateTime(value: DateInput): string {
  return formatWith(value, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

export function formatDate(value: DateInput): string {
  return formatWith(value, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
}

export function formatTime(value: DateInput, options: { readonly seconds?: boolean } = {}): string {
  return formatWith(value, {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  })
}

export function formatMonthDayTime(value: DateInput): string {
  return formatWith(value, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return cachedFormat(numberFormats, options, (locale) => new Intl.NumberFormat(locale, options)).format(value)
}

export function formatPercent(fraction: number, digits = 1): string {
  return formatNumber(fraction, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function formatRelativeTime(value: DateInput, options: { readonly addSuffix?: boolean } = {}): string {
  return formatDistanceToNow(toDate(value), {
    addSuffix: options.addSuffix ?? true,
    locale: getLocale() === 'ko' ? ko : enUS,
  })
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function formatCompactDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const korean = getLocale() === 'ko'
  if (hours > 0) return korean ? `${hours}시간 ${pad(minutes)}분` : `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return korean ? `${minutes}분 ${pad(seconds)}초` : `${minutes}m ${pad(seconds)}s`
  return korean ? `${seconds}초` : `${seconds}s`
}

export function formatDatePattern(value: DateInput, enPattern: string, koPattern: string): string {
  return getLocale() === 'ko' ? format(toDate(value), koPattern, { locale: ko }) : format(toDate(value), enPattern)
}
