import {
  isCallExpression,
  isNewExpression,
  isIdentifier,
  isStringLiteralLike,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
} from 'typescript'
import type { Node, Expression } from 'typescript'
import { callName } from './ast'

function hasOption(node: Expression | undefined, names: readonly string[]): boolean {
  return Boolean(
    node &&
    isObjectLiteralExpression(node) &&
    node.properties.some(
      (property) =>
        (isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) &&
        names.includes(property.name.getText().replace(/^['"]|['"]$/g, '')),
    ),
  )
}

export function isRawDate(node: Node): boolean {
  if (!isCallExpression(node) && !isNewExpression(node)) return false
  const name = callName(node.expression)
  const args = node.arguments ?? []
  const first = args[0]
  const implicit = !first || (isIdentifier(first) && first.text === 'undefined')
  const fixed = first && isStringLiteralLike(first)
  if (/\.(toLocaleString|toLocaleDateString|toLocaleTimeString)$/.test(name)) {
    if (implicit) return true
    if (!fixed) return false
    return (
      !name.endsWith('.toLocaleString') ||
      hasOption(args[1], ['year', 'month', 'day', 'weekday', 'hour', 'minute', 'second'])
    )
  }
  if (isNewExpression(node) && ['Intl.DateTimeFormat', 'Intl.NumberFormat'].includes(name))
    return implicit || Boolean(fixed && name === 'Intl.DateTimeFormat')
  if (name === 'formatDistanceToNow') return true
  if (name === 'cronstrue.toString') return !hasOption(args[1], ['locale'])
  const pattern = args[1]
  if (name === 'format' && pattern && isStringLiteralLike(pattern) && !hasOption(args[2], ['locale'])) {
    return /MMM|LLL|E|eee|ccc|[abBPp]/.test(pattern.text.replace(/'[^']*'/g, ''))
  }
  return false
}
