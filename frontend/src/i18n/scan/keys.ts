import {
  forEachChild,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isParenthesizedExpression,
  isStringLiteralLike,
  SyntaxKind,
} from 'typescript'
import type { Node } from 'typescript'
import { callName, parseSource, translationNames } from './ast'

export interface UsedKey {
  readonly file: string
  readonly line: number
  readonly key: string
  readonly parts: readonly string[]
}

function resultLiterals(node: Node | undefined): string[] {
  if (!node) return []
  if (isStringLiteralLike(node)) return node.text ? [node.text] : []
  if (isParenthesizedExpression(node)) return resultLiterals(node.expression)
  if (isConditionalExpression(node)) return [...resultLiterals(node.whenTrue), ...resultLiterals(node.whenFalse)]
  if (
    isBinaryExpression(node) &&
    [SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken, SyntaxKind.AmpersandAmpersandToken].includes(
      node.operatorToken.kind,
    )
  ) {
    return [...resultLiterals(node.left), ...resultLiterals(node.right)]
  }
  return []
}

export function collectKeys(filePath: string, sourceText: string): UsedKey[] {
  const file = filePath.replaceAll('\\', '/')
  const source = parseSource(file, sourceText)
  const names = translationNames(source)
  const keys: UsedKey[] = []
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      const name = names.get(callName(node.expression))
      const [first, second] = node.arguments
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      if (name === 'tn') {
        for (const one of resultLiterals(first)) {
          for (const other of resultLiterals(second)) {
            keys.push({ file, line, key: `${one}|${other}`, parts: [one, other] })
          }
        }
      } else if (name) {
        for (const key of resultLiterals(first)) {
          keys.push({ file, line, key, parts: [key] })
        }
      }
    }
    forEachChild(node, visit)
  }
  visit(source)
  return keys
}
