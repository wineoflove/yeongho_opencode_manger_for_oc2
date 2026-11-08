import { forEachChild, isJsxText, isCallExpression, isFunctionLike, isPropertyDeclaration } from 'typescript'
import type { Node } from 'typescript'
import { ancestors, callName, insideTranslation, literalText, parseSource, translationNames } from './ast'
import { ALLOWED_FINDINGS, ALLOWED_TEXT } from './allow'
import { insideCode, literalKind } from './literalRules'
import { isRawDate } from './rawDate'

export type FindingKind =
  'jsx-text' | 'jsx-expr' | 'jsx-attr' | 'toast' | 'error-text' | 'ui-prop' | 'ui-literal' | 'module-t' | 'raw-date'
export interface Finding {
  readonly file: string
  readonly line: number
  readonly kind: FindingKind
  readonly text: string
}

export function scanSource(filePath: string, sourceText: string): Finding[] {
  const file = filePath.replaceAll('\\', '/')
  const source = parseSource(file, sourceText)
  const names = translationNames(source)
  const findings: Finding[] = []
  const report = (node: Node, kind: FindingKind, text: string) => {
    if (ALLOWED_FINDINGS.some((allowed) => allowed.file === file && allowed.text === text)) return
    findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, text })
  }
  const visit = (node: Node): void => {
    const text = isJsxText(node) ? node.text.trim() : literalText(node)
    if (
      text &&
      /[A-Za-z]{2,}/.test(text) &&
      !insideCode(node) &&
      !insideTranslation(node, names) &&
      !ALLOWED_TEXT.some((pattern) => pattern.test(text))
    ) {
      const kind = isJsxText(node) ? 'jsx-text' : literalKind(node, text)
      if (kind) report(node, kind, text)
    }
    if (isCallExpression(node) && ['t', 'tn', 'tr'].includes(names.get(callName(node.expression)) ?? '')) {
      const boundary = ancestors(node).find((parent) => isFunctionLike(parent) || isPropertyDeclaration(parent))
      if (!boundary || isPropertyDeclaration(boundary)) report(node, 'module-t', node.getText(source))
    }
    if (!/(?:^|\/)src\/i18n\//.test(file) && isRawDate(node)) report(node, 'raw-date', node.getText(source))
    forEachChild(node, visit)
  }
  visit(source)
  return findings
}
