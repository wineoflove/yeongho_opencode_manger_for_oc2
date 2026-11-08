import { Fragment, type ReactNode } from 'react'
import { template } from './translate'

const PLACEHOLDER = /\{(\w+)\}/g

export function tr(key: string, vars: Readonly<Record<string, ReactNode>>): ReactNode[] {
  const text = template(key)
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (name === undefined || !Object.hasOwn(vars, name)) continue
    if (match.index > cursor) {
      nodes.push(<Fragment key={`text${nodes.length}`}>{text.slice(cursor, match.index)}</Fragment>)
    }
    nodes.push(<Fragment key={`${name}${nodes.length}`}>{vars[name]}</Fragment>)
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) {
    nodes.push(<Fragment key={`text${nodes.length}`}>{text.slice(cursor)}</Fragment>)
  }
  return nodes
}
