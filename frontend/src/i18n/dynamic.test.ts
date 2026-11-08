import { describe, it, expect } from 'vitest'
import { getPermissionLabel } from '@opencode-manager/shared/notifications'
import { commonDynamicKeys } from './dynamic/common'
import { KO, findConflictingKeys } from './ko'

const PERMISSIONS = [
  'read',
  'edit',
  'glob',
  'grep',
  'shell',
  'subagent',
  'external_directory',
  'question',
  'webfetch',
  'websearch',
  'skill',
  '',
]

describe('common dynamic keys', () => {
  it('declares and translates every permission label', () => {
    const labels = PERMISSIONS.map(getPermissionLabel)

    expect(new Set(labels).size).toBe(PERMISSIONS.length)
    for (const label of labels) {
      expect(commonDynamicKeys).toContain(label)
      expect(KO[label]).toBeTruthy()
    }
  })
})

describe('findConflictingKeys', () => {
  it('reports no conflicts in the shipped catalog', () => {
    expect(findConflictingKeys()).toEqual([])
  })

  it('finds a key with different values across files', () => {
    const conflicts = findConflictingKeys({
      common: { Save: '저장', Close: '닫기' },
      settings: { Save: '저장하기', Close: '닫기' },
      misc: { Save: '저장' },
    })

    expect(conflicts).toEqual([{ key: 'Save', values: { common: '저장', settings: '저장하기', misc: '저장' } }])
  })
})
