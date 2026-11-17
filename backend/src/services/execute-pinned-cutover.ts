import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { z } from 'zod'
import { openCutoverJournal } from './cutover-journal-store'
import { predictCutoverCommit } from './cutover-commit-reference'
import { runCutoverSteps, recoverCutoverSteps, parseJournal } from './cutover-step-runner'
import type { CutoverStep } from './cutover-step-runner'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { durableTransferRecord } from './claude-transfer-activate'
import { CutoverPublicationUncertainError } from './cutover-publication-error'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const referenceSchema = z
  .object({
    path: z.string(),
    sha256: digest,
    plan: z.array(z.string()).min(1),
    journalRecords: z.number().int().positive(),
    activationAuthorized: z.literal(false),
  })
  .strict()

export async function inspectPinnedCutover(input: {
  readonly stateDirectory: string
  readonly planIdentity: string
  readonly expectedCommit: z.infer<typeof referenceSchema>
}) {
  const expected = referenceSchema.parse(input.expectedCommit)
  digest.parse(input.planIdentity)
  const directory = await lstat(input.stateDirectory)
  if (
    (await realpath(input.stateDirectory)) !== input.stateDirectory ||
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new Error('CUTOVER_EXECUTION_SCOPE_REJECTED')
  const journalDirectory = join(input.stateDirectory, 'journal')
  if (expected.path !== join(journalDirectory, `${String(expected.journalRecords).padStart(6, '0')}.json`))
    throw new Error('CUTOVER_EXECUTION_SCOPE_REJECTED')
  const journal = await openCutoverJournal(journalDirectory)
  try {
    const latest = journal.latest()
    if (latest === undefined) return { phase: 'not-started' as const }
    const binding = JSON.stringify({
      version: 1,
      planIdentity: input.planIdentity,
      expectedCommit: expected,
    })
    if ((await readPrivateTransferFile(join(input.stateDirectory, 'execution-binding.json'))) !== binding)
      throw new Error('CUTOVER_EXECUTION_BINDING_CHANGED')
    const state = parseJournal(
      latest,
      expected.plan.map((name) => ({
        name,
        forward: async () => {},
        rollback: async () => {},
      })),
    )
    if (state.phase === 'committed') {
      try {
        if (
          createHash('sha256')
            .update(await readPrivateTransferFile(expected.path))
            .digest('hex') !== expected.sha256
        )
          throw new Error('COMMIT_MISMATCH')
      } catch {
        throw new CutoverPublicationUncertainError()
      }
    }
    return state
  } finally {
    await journal.close()
  }
}

export async function executePinnedCutover(input: {
  readonly mode: 'apply' | 'recover'
  readonly journalDirectory: string
  readonly stateDirectory: string
  readonly planIdentity: string
  readonly expectedCommit: z.infer<typeof referenceSchema>
  readonly steps: readonly CutoverStep[]
  readonly assertReady: () => Promise<void>
}) {
  const expected = referenceSchema.parse(input.expectedCommit)
  const directory = await lstat(input.stateDirectory)
  if (
    (await realpath(input.stateDirectory)) !== input.stateDirectory ||
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    directory.mode & 0o077
  )
    throw new Error('CUTOVER_EXECUTION_SCOPE_REJECTED')
  digest.parse(input.planIdentity)
  if (!['apply', 'recover'].includes(input.mode) || input.journalDirectory !== join(input.stateDirectory, 'journal'))
    throw new Error('CUTOVER_EXECUTION_SCOPE_REJECTED')
  const steps = Object.freeze(input.steps.map((step) => Object.freeze({ ...step })))
  if (JSON.stringify(steps.map((step) => step.name)) !== JSON.stringify(expected.plan))
    throw new Error('CUTOVER_EXECUTION_PLAN_CHANGED')
  const binding = {
    version: 1,
    planIdentity: input.planIdentity,
    expectedCommit: expected,
  }
  const bindingText = JSON.stringify(binding)
  const bindingPath = join(input.stateDirectory, 'execution-binding.json')
  const journal = await openCutoverJournal(input.journalDirectory)
  const assertExpectedCommit = async () => {
    try {
      const text = await readPrivateTransferFile(expected.path)
      if (createHash('sha256').update(text).digest('hex') !== expected.sha256) throw new Error('COMMIT_MISMATCH')
    } catch {
      throw new CutoverPublicationUncertainError()
    }
  }
  try {
    if (input.mode === 'apply') {
      if (journal.latest() !== undefined) throw new Error('CUTOVER_EXECUTION_ALREADY_STARTED')
      const predicted = await predictCutoverCommit(input.journalDirectory, expected.plan)
      if (JSON.stringify(predicted) !== JSON.stringify(expected)) throw new Error('CUTOVER_EXECUTION_COMMIT_CHANGED')
      try {
        await durableTransferRecord(bindingPath, binding)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        if ((await readPrivateTransferFile(bindingPath)) !== bindingText)
          throw new Error('CUTOVER_EXECUTION_BINDING_CHANGED')
      }
      await input.assertReady()
      const result = await runCutoverSteps({ steps, persist: journal.persist })
      await assertExpectedCommit()
      return result
    }
    if ((await readPrivateTransferFile(bindingPath)) !== bindingText)
      throw new Error('CUTOVER_EXECUTION_BINDING_CHANGED')
    if (journal.latest() === undefined) throw new Error('CUTOVER_EXECUTION_NOT_STARTED')
    const result = await recoverCutoverSteps({
      steps,
      persist: journal.persist,
      journal: journal.latest(),
    })
    if (result.phase === 'committed') await assertExpectedCommit()
    return result
  } finally {
    await journal.close()
  }
}
