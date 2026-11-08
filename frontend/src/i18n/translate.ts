import { getLocale } from './locale'
import { KO } from './ko'

export type TranslateVars = Readonly<Record<string, string | number>>

const PLACEHOLDER = /\{(\w+)\}/g
const enPluralRules = new Intl.PluralRules('en-US')

export function template(key: string): string {
  return getLocale() === 'ko' ? (KO[key] ?? key) : key
}

function fill(text: string, vars: TranslateVars | undefined): string {
  if (!vars) return text
  return text.replace(PLACEHOLDER, (match, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : match))
}

export function t(key: string, vars?: TranslateVars): string {
  return fill(template(key), vars)
}

export function tn(one: string, other: string, count: number, vars?: TranslateVars): string {
  const text =
    getLocale() === 'ko' ? (KO[`${one}|${other}`] ?? other) : enPluralRules.select(count) === 'one' ? one : other
  return fill(text, { count: String(count), ...vars })
}

export function msg(key: string): string {
  return key
}
