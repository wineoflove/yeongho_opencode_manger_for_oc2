import { z } from 'zod'

export const LEARNING_PATTERN_KEY_SOURCE = '^[a-z0-9]+(?:-[a-z0-9]+)*(?:\\.[a-z0-9]+(?:-[a-z0-9]+)*)+$'

export const LearningRecordInputSchema = z.object({
  title: z.string().min(1).max(160),
  patternKey: z.string().regex(new RegExp(LEARNING_PATTERN_KEY_SOURCE)),
  status: z.enum(['pending', 'verified']),
  kind: z.enum(['correction', 'error', 'solution', 'preference']),
  source: z.string().min(1).max(400),
  conditions: z.string().min(1).max(800),
  evidence: z.string().min(1).max(1500),
  related: z.array(z.string()).max(10).default([]),
  lesson: z.string().min(1).max(1500),
  limits: z.string().min(1).max(1200),
})
export type LearningRecordInput = z.infer<typeof LearningRecordInputSchema>

export const LearningSearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(10).default(5),
  includePending: z.boolean().default(false),
  maxChars: z.number().int().min(1500).max(16000).default(6000),
})
export type LearningSearchInput = z.infer<typeof LearningSearchInputSchema>

export const LearningLintReportSchema = z.object({
  scanned: z.number().int().nonnegative(),
  counts: z.object({
    verified: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  }),
  violations: z.array(
    z.object({
      file: z.string(),
      id: z.string().nullable(),
      code: z.enum([
        'MISSING_FIELD',
        'ID_FILENAME_MISMATCH',
        'DUPLICATE_ID',
        'INVALID_STATUS',
        'INVALID_KIND',
        'INVALID_PATTERN_KEY',
        'UNKNOWN_RELATED',
      ]),
      detail: z.string(),
    }),
  ),
})
export type LearningLintReport = z.infer<typeof LearningLintReportSchema>
