import { useSyncExternalStore } from 'react'

export type Locale = 'ko' | 'en'

export const DEFAULT_LOCALE: Locale = 'ko'
export const LOCALE_STORAGE_KEY = 'oc:locale'

function isLocale(value: unknown): value is Locale {
  return value === 'ko' || value === 'en'
}

function readStoredLocale(): Locale {
  if (typeof localStorage === 'undefined') return DEFAULT_LOCALE
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY)
  return isLocale(stored) ? stored : DEFAULT_LOCALE
}

function syncDocumentLang(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

let current: Locale = readStoredLocale()
let lastServerLocale: Locale | undefined
const listeners = new Set<() => void>()

syncDocumentLang(current)

export function getLocale(): Locale {
  return current
}

export function setLocale(locale: Locale): void {
  if (locale === current) return
  current = locale
  if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  syncDocumentLang(locale)
  for (const listener of listeners) listener()
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale)
}

export function applyServerLocale(value: Locale | undefined): void {
  if (value === undefined || value === lastServerLocale) return
  lastServerLocale = value
  setLocale(value)
}

export function resetLocaleStateForTests(): void {
  lastServerLocale = undefined
}
