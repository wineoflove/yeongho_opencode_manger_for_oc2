import { z } from '../../shared/src/zod.ts'
import { digest, redact } from './data.mjs'

export const ANALYSIS_LIMITS = { text: 1800, list: 8, lessons: 5, sourceIds: 8, policyFindings: 200 }

const line = z.string().max(ANALYSIS_LIMITS.text)
export const Analysis = z
  .object({
    summary: line,
    recurring: z.array(line).max(8),
    uncertainties: z.array(line).max(8),
    suggestions: z.array(line).max(8),
    policyFindings: z
      .array(
        z
          .object({
            sourceId: z.string().max(200),
            action: z.enum(['keep', 'change', 'remove', 'defer']),
            reason: line,
          })
          .strict(),
      )
      .max(200)
      .default([]),
    lessons: z
      .array(
        z.object({
          patternKey: z.string().regex(/^[a-z0-9][a-z0-9.-]{2,100}$/),
          kind: z.enum(['correction', 'error', 'solution', 'preference']),
          lesson: line,
          conditions: line,
          evidence: line,
          limits: line,
          sourceIds: z.array(z.string().max(180)).min(1).max(8),
        }),
      )
      .max(5),
  })
  .strict()

const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

function capAnalysis(value) {
  const adjustments = []
  if (!isRecord(value)) return { value, adjustments }
  const clip = (text, label) => {
    if (typeof text !== 'string' || text.length <= ANALYSIS_LIMITS.text) return text
    adjustments.push(`${label}: ${text.length}자 중 ${ANALYSIS_LIMITS.text}자까지만 사용`)
    return `${text.slice(0, ANALYSIS_LIMITS.text - 1)}…`
  }
  const cap = (items, max, label) => {
    if (!Array.isArray(items) || items.length <= max) return items
    adjustments.push(`${label}: ${items.length}개 중 ${max}개만 사용`)
    return items.slice(0, max)
  }
  const result = { ...value, summary: clip(value.summary, 'summary') }
  for (const key of ['recurring', 'uncertainties', 'suggestions']) {
    const items = cap(value[key], ANALYSIS_LIMITS.list, key)
    result[key] = Array.isArray(items) ? items.map((item, index) => clip(item, `${key}[${index}]`)) : items
  }
  const findings = cap(value.policyFindings, ANALYSIS_LIMITS.policyFindings, 'policyFindings')
  if (Array.isArray(findings))
    result.policyFindings = findings.map((item, index) =>
      isRecord(item) ? { ...item, reason: clip(item.reason, `policyFindings[${index}].reason`) } : item,
    )
  const lessons = cap(value.lessons, ANALYSIS_LIMITS.lessons, 'lessons')
  if (Array.isArray(lessons))
    result.lessons = lessons.map((lesson, index) => {
      if (!isRecord(lesson)) return lesson
      const next = { ...lesson }
      for (const key of ['lesson', 'conditions', 'evidence']) next[key] = clip(lesson[key], `lessons[${index}].${key}`)
      let note = ''
      if (Array.isArray(lesson.sourceIds)) {
        const unique = [...new Set(lesson.sourceIds)]
        if (unique.length > ANALYSIS_LIMITS.sourceIds) {
          note = `근거 메시지 ${unique.length}개 중 ${ANALYSIS_LIMITS.sourceIds}개만 기록함. `
          adjustments.push(`lessons[${index}].sourceIds: ${unique.length}개 중 ${ANALYSIS_LIMITS.sourceIds}개만 기록`)
        }
        next.sourceIds = unique.slice(0, ANALYSIS_LIMITS.sourceIds)
      }
      next.limits =
        typeof lesson.limits === 'string' ? `${note}${lesson.limits}`.slice(0, ANALYSIS_LIMITS.text) : lesson.limits
      return next
    })
  return { value: result, adjustments }
}

const listIds = (ids) =>
  ids
    .slice(0, 3)
    .map((id) => String(id).slice(0, 60))
    .join(', ') + (ids.length > 3 ? ` 외 ${ids.length - 3}개` : '')

function dropUncollectedSources(value, records) {
  const adjustments = []
  if (!isRecord(value) || !Array.isArray(value.lessons)) return { value, adjustments }
  const ids = new Set(records.map((record) => record.id))
  const lessons = []
  value.lessons.forEach((lesson, index) => {
    if (!isRecord(lesson) || !Array.isArray(lesson.sourceIds)) return lessons.push(lesson)
    const invalid = lesson.sourceIds.filter((id) => !ids.has(id))
    if (!invalid.length) return lessons.push(lesson)
    const valid = lesson.sourceIds.filter((id) => ids.has(id))
    if (!valid.length) {
      adjustments.push(`lessons[${index}] 제외: 근거가 모두 수집되지 않은 ID(${listIds(invalid)})`)
      return undefined
    }
    adjustments.push(`lessons[${index}].sourceIds: 수집되지 않은 ID ${invalid.length}개 제거(${listIds(invalid)})`)
    const note = `수집되지 않은 근거 ${invalid.length}개는 기록하지 않음. `
    return lessons.push({
      ...lesson,
      sourceIds: valid,
      limits: typeof lesson.limits === 'string' ? `${note}${lesson.limits}` : lesson.limits,
    })
  })
  return { value: { ...value, lessons }, adjustments }
}

export function validateAnalysis(value, records) {
  const sourced = dropUncollectedSources(JSON.parse(redact(JSON.stringify(value))), records)
  const capped = capAnalysis(sourced.value)
  const parsed = Analysis.parse(capped.value)
  const adjustments = [...sourced.adjustments, ...capped.adjustments]
  const instructions = new Set(
    records.filter((record) => record.kind === 'current-instruction').map((record) => record.id),
  )
  const invalidFindings = parsed.policyFindings.filter((finding) => !instructions.has(finding.sourceId))
  if (invalidFindings.length)
    adjustments.push(
      `policyFindings: 수집되지 않은 지침 ${invalidFindings.length}개 제외(${listIds(invalidFindings.map((item) => item.sourceId))})`,
    )
  return {
    ...parsed,
    policyFindings: parsed.policyFindings.filter((finding) => instructions.has(finding.sourceId)),
    adjustments,
  }
}

export function failureNotice(mode, runId, detail, now = Date.now()) {
  return {
    messageID: `msg_${((BigInt(now) << 12n) + 2n).toString(16).slice(-12)}${digest([runId, detail]).slice(0, 14)}`,
    text: `## ${mode === 'daily' ? '일일' : '주간'} 학습 리뷰 실패\n\n${detail}\n\n처리 위치는 전진시키지 않았습니다. 같은 자료는 다음 실행에서 다시 분석합니다.`,
  }
}

export function formatReport(mode, batch, analysis, date, created) {
  return (
    `## ${mode === 'daily' ? '일일' : '주간'} 학습 리뷰 — ${date}\n\n` +
    `검토 자료: ${batch.records.length}건 · 신규 pending 후보: ${created}개 · 미처리 자료: ${batch.more ? '있음(다음 배치)' : '이번 조회 범위 없음'}\n\n` +
    `${analysis.summary}\n\n${
      batch.coverage
        ? `전체 입력: 학습 ${batch.coverage.learningRecords}건 · 지침 ${batch.coverage.policyFiles}파일/${batch.coverage.policySections}구간. 구간별 후속 검토 완료 여부는 별도 receipt로 확인합니다.\n\n`
        : ''
    }${[
      ['반복 문제', analysis.recurring],
      ['추가 확인 필요', analysis.uncertainties],
      ['개선 제안', analysis.suggestions],
      [
        '기존 지침 검토 제안',
        (analysis.policyFindings ?? []).map((item) => `${item.sourceId} · ${item.action}: ${item.reason}`),
      ],
      ...(analysis.adjustments?.length ? [['분석 결과 형식 상한 조정', analysis.adjustments]] : []),
    ]
      .map(([name, items]) => `### ${name}\n${items.length ? items.map((x) => `- ${x}`).join('\n') : '- 없음'}`)
      .join(
        '\n\n',
      )}\n\n이 보고서는 분석 단계 결과입니다. 승인된 예약 작업의 후속 단계에서 안전한 수정·독립 검증·근거 기반 승격을 진행하며, 처리 결과와 보류 사유는 별도 보고합니다. 검증 전 후보는 pending을 유지합니다.\n`
  )
}
