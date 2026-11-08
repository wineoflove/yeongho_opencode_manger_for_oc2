import {
  createSourceFile,
  ScriptKind,
  ScriptTarget,
  isIdentifier,
  isPropertyAccessExpression,
  isImportDeclaration,
  isStringLiteral,
  isNamedImports,
  isCallExpression,
  isStringLiteralLike,
  isTemplateHead,
  isTemplateMiddle,
  isTemplateTail,
  SyntaxKind,
} from 'typescript'
import type { Node, SourceFile, Expression } from 'typescript'

export function parseSource(file: string, text: string): SourceFile {
  return createSourceFile(file, text, ScriptTarget.Latest, true, file.endsWith('.ts') ? ScriptKind.TS : ScriptKind.TSX)
}

export function ancestors(node: Node): Node[] {
  const result: Node[] = []
  for (let parent = node.parent; parent; parent = parent.parent) result.push(parent)
  return result
}

export function callName(expression: Expression): string {
  if (expression.kind === SyntaxKind.ImportKeyword) return 'import'
  if (isIdentifier(expression)) return expression.text
  if (isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`
  return ''
}

export function translationNames(source: SourceFile): ReadonlyMap<string, string> {
  const names = new Map(['t', 'tn', 'tr', 'msg'].map((name) => [name, name]))
  for (const statement of source.statements) {
    if (!isImportDeclaration(statement) || !isStringLiteral(statement.moduleSpecifier)) continue
    const path = statement.moduleSpecifier.text
    const relative = source.fileName.replaceAll('\\', '/').includes('/i18n/') && path.startsWith('.')
    if (!/(?:^|\/)i18n(?:\/|$)/.test(path) && !relative) continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !isNamedImports(bindings)) continue
    for (const binding of bindings.elements) {
      const original = binding.propertyName?.text ?? binding.name.text
      if (['t', 'tn', 'tr', 'msg'].includes(original)) names.set(binding.name.text, original)
    }
  }
  return names
}

export function insideTranslation(node: Node, names: ReadonlyMap<string, string>): boolean {
  return ancestors(node).some((parent) => isCallExpression(parent) && names.has(callName(parent.expression)))
}

export function literalText(node: Node): string | undefined {
  return isStringLiteralLike(node) || isTemplateHead(node) || isTemplateMiddle(node) || isTemplateTail(node)
    ? node.text
    : undefined
}
