import { z } from '../../shared/src/zod.ts'
import { absolutePath, hash } from './application-files.mjs'

const note = z.string().min(1).max(2000)
const reference = z.string().min(1).max(1000)
const check = z
  .object({
    kind: z.enum(['test', 'typecheck', 'lint', 'build', 'readback', 'policy-review', 'runtime']),
    command: note,
    cwd: absolutePath,
    exitCode: z.literal(0),
    scope: note,
    evidence: reference,
  })
  .strict()

export const Decision = z
  .object({
    patternKey: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    entryIds: z.array(z.string().min(1)).min(1).max(100),
    expectedRevision: z.number().int().nonnegative(),
    decision: z.enum(['planned', 'blocked', 'applied', 'not_applicable', 'retired']),
    summary: note,
    rationale: note,
    evidence: z.array(reference).min(1).max(20),
    targets: z
      .array(
        z
          .object({
            snapshot: reference,
            afterHash: hash,
            change: z.enum(['modified', 'existing']),
            requirement: note,
            anchor: z.string().min(8).max(2000).optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    checks: z.array(check).max(30).default([]),
    runtime: z
      .object({
        status: z.enum(['not_required', 'pending', 'verified']),
        reason: note,
        evidence: z.array(reference).max(20).default([]),
      })
      .strict(),
    unblockWhen: note.optional(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (new Set(decision.entryIds).size !== decision.entryIds.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate entry IDs' })
    if (decision.decision === 'applied' && (!decision.targets.length || !decision.checks.length))
      ctx.addIssue({ code: 'custom', message: 'Applied requires targets and passing checks' })
    if (decision.decision === 'blocked' && !decision.unblockWhen)
      ctx.addIssue({ code: 'custom', message: 'Blocked requires unblock condition' })
    if (
      decision.runtime.status === 'verified' &&
      (decision.decision !== 'applied' ||
        !decision.runtime.evidence.length ||
        !decision.checks.some((item) => item.kind === 'runtime'))
    )
      ctx.addIssue({ code: 'custom', message: 'Runtime requires its own evidence and check' })
  })

export const PolicyReview = z
  .object({
    manifest: reference,
    decisions: z
      .array(
        z
          .object({
            sectionId: reference,
            decision: z.enum(['keep', 'change', 'remove', 'defer']),
            reason: note,
            evidence: z.array(reference).min(1),
            applicationEvent: reference.optional(),
          })
          .strict(),
      )
      .min(1),
    addedSections: z
      .array(
        z
          .object({
            sectionId: reference,
            reason: note,
            applicationEvent: reference,
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
