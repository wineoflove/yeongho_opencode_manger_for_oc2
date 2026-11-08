import {
  isJsxElement,
  isJsxExpression,
  isJsxAttribute,
  isCallExpression,
  isNewExpression,
  isPropertyAssignment,
  isIdentifier,
  isStringLiteralLike,
  isTemplateExpression,
  isTemplateSpan,
  isParenthesizedExpression,
  isConditionalExpression,
  isBinaryExpression,
  isTypeNode,
  isInterfaceDeclaration,
  isEnumMember,
  isElementAccessExpression,
  isImportDeclaration,
  isExportDeclaration,
  isCaseClause,
  isPropertyAccessExpression,
  SyntaxKind,
} from 'typescript'
import type { Node } from 'typescript'
import { ancestors, callName } from './ast'

const visibleAttributes = new Set(
  'title placeholder aria-label alt label description tooltip emptyMessage helperText confirmLabel cancelLabel heading subtitle'.split(
    ' ',
  ),
)
const visibleProperties = new Set(
  'label title description placeholder emptyText helpText tooltip summary heading subtitle message hint actionLabel confirmLabel cancelLabel'.split(
    ' ',
  ),
)
const hiddenAttributes = new Set(
  'className key id type role name htmlFor href to src value defaultValue variant size side align mode method autoComplete inputMode target rel accept pattern lang dir aria-controls aria-describedby aria-labelledby'.split(
    ' ',
  ),
)
const hiddenProperties = new Set(
  'queryKey mutationKey key id type kind variant className path to href url method mode status value code headers'.split(
    ' ',
  ),
)
const hiddenCalls = new Set(
  'cn clsx cva twMerge t tn tr msg querySelector querySelectorAll getElementById addEventListener removeEventListener matchMedia fetch fetchWrapper format require import'.split(
    ' ',
  ),
)
const stringMethods = new Set('includes startsWith endsWith indexOf split replace match'.split(' '))
const comparisons = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
])

function propertyName(node: Node): string {
  return isIdentifier(node) || isStringLiteralLike(node) ? node.text : ''
}

export function insideCode(node: Node): boolean {
  return ancestors(node).some(
    (parent) => isJsxElement(parent) && ['code', 'kbd', 'pre'].includes(parent.openingElement.tagName.getText()),
  )
}

function isResultPath(node: Node, target: Node): boolean {
  let current = node
  while (current !== target) {
    const parent = current.parent
    if (!parent) return false
    if (isConditionalExpression(parent) && parent.condition === current) return false
    if (
      isBinaryExpression(parent) &&
      ![SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken].includes(
        parent.operatorToken.kind,
      )
    )
      return false
    if (!(
      isParenthesizedExpression(parent) ||
      isConditionalExpression(parent) ||
      isBinaryExpression(parent) ||
      isTemplateExpression(parent) ||
      isTemplateSpan(parent) ||
      parent === target
    ))
      return false
    current = parent
  }
  return true
}

function toastLiteral(node: Node): boolean {
  const parents = ancestors(node)
  for (const parent of parents) {
    if (!isCallExpression(parent)) continue
    const name = callName(parent.expression)
    if (!/^(toast(?:\.\w+)?|showToast\.\w+)$/.test(name)) return false
    const first = parent.arguments[0]
    if (first && isResultPath(node, first)) return true
    const properties = parents.filter(isPropertyAssignment).map((property) => propertyName(property.name))
    if (properties[0] === 'description' || (properties[0] === 'label' && properties[1] === 'action')) return true
    return name.endsWith('.promise') && ['loading', 'success', 'error'].includes(properties[0] ?? '')
  }
  return false
}

function excludedLiteral(node: Node): boolean {
  let child = node
  for (const parent of ancestors(node)) {
    if (
      isTypeNode(parent) ||
      isInterfaceDeclaration(parent) ||
      isEnumMember(parent) ||
      isImportDeclaration(parent) ||
      isExportDeclaration(parent)
    )
      return true
    if (
      isJsxAttribute(parent) &&
      (hiddenAttributes.has(parent.name.getText()) || parent.name.getText().startsWith('data-'))
    )
      return true
    if (isPropertyAssignment(parent) && (parent.name === child || hiddenProperties.has(propertyName(parent.name))))
      return true
    if (isElementAccessExpression(parent) && parent.argumentExpression === child) return true
    if (isCaseClause(parent) && parent.expression === child) return true
    if (
      isBinaryExpression(parent) &&
      (comparisons.has(parent.operatorToken.kind) ||
        (parent.operatorToken.kind === SyntaxKind.InKeyword && parent.left === child))
    )
      return true
    if (isCallExpression(parent)) {
      const name = callName(parent.expression)
      const method = isPropertyAccessExpression(parent.expression) ? parent.expression.name.text : name
      if (
        hiddenCalls.has(name) ||
        hiddenCalls.has(method) ||
        stringMethods.has(method) ||
        /^(console|localStorage|sessionStorage)\./.test(name)
      )
        return true
    }
    child = parent
  }
  return false
}

export function literalKind(
  node: Node,
  text: string,
): 'jsx-expr' | 'jsx-attr' | 'toast' | 'error-text' | 'ui-prop' | 'ui-literal' | undefined {
  const parents = ancestors(node)
  const expression = parents.find(isJsxExpression)
  if (expression && !isJsxAttribute(expression.parent) && isResultPath(node, expression)) return 'jsx-expr'
  const attribute = parents.find(isJsxAttribute)
  if (attribute && visibleAttributes.has(attribute.name.getText())) return 'jsx-attr'
  if (toastLiteral(node)) return 'toast'
  const creation = parents.find(isNewExpression)
  if (
    creation &&
    callName(creation.expression) === 'Error' &&
    creation.arguments?.[0] &&
    isResultPath(node, creation.arguments[0])
  )
    return 'error-text'
  const property = parents.find(isPropertyAssignment)
  if (
    property &&
    property.name !== node &&
    visibleProperties.has(propertyName(property.name)) &&
    isResultPath(node, property.initializer)
  )
    return 'ui-prop'
  if (/^\s*[A-Z][a-z]+/.test(text) && !excludedLiteral(node)) return 'ui-literal'
  return undefined
}
