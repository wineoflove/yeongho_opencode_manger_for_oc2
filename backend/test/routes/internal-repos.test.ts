import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { ScheduleService } from '../../src/services/schedules'
import { SettingsService } from '../../src/services/settings'
import { createOpenCodeClient } from '../../src/services/opencode/client'
import { allMigrations } from '../../src/db/migrations'
import { getOrCreateInternalToken } from '../../src/services/internal-token'
import { migrate } from '../../src/db/migration-runner'
import { createRepo, getRepoById, listRepos } from '../../src/db/queries'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import type { CreateRepoInput } from '../../src/types/repo'
import type { ScheduleWorktreeManager } from '../../src/services/schedule-worktree'
import { createInternalTestApp } from '../helpers/internal-test-app'
import { GitAuthService } from '../../src/services/git-auth'

describe('internal-repos routes', () => {
  let db: Database
  let scheduleService: ScheduleService
  let settingsService: SettingsService
  let app: Hono
  let token: string

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db, allMigrations)
    const openCodeClient = createOpenCodeClient()
    const stubWorktreeManager = { prepare: () => Promise.resolve(null), finalize: () => Promise.resolve({ commitHash: null }) } as unknown as ScheduleWorktreeManager
    scheduleService = new ScheduleService(db, openCodeClient, stubWorktreeManager)
    settingsService = new SettingsService(db)
    app = new Hono()
    app.route('/api/internal', createInternalTestApp(db, { scheduleService, settingsService, gitAuthService: new GitAuthService() }))
    token = getOrCreateInternalToken(db)
  })

  it('GET /api/internal/repos returns 401 without bearer token', async () => {
    const res = await app.request('/api/internal/repos')
    expect(res.status).toBe(401)
  })

  it('GET /api/internal/repos returns 200 with bearer token', async () => {
    const res = await app.request('/api/internal/repos', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { repos: unknown[] }
    expect(body).toHaveProperty('repos')
    expect(Array.isArray(body.repos)).toBe(true)
  })

  it('GET /api/internal/repos returns repos in default order', async () => {
    const repo1Input: CreateRepoInput = {
      localPath: 'repo1',
      defaultBranch: 'main',
      cloneStatus: 'ready',
      clonedAt: Date.now(),
      isLocal: true,
    }
    const repo2Input: CreateRepoInput = {
      localPath: 'repo2',
      defaultBranch: 'main',
      cloneStatus: 'ready',
      clonedAt: Date.now(),
      isLocal: true,
    }
    createRepo(db, repo1Input)
    createRepo(db, repo2Input)

    const res = await app.request('/api/internal/repos', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { repos: Array<{ id: number; localPath: string }> }
    expect(body.repos.length).toBe(2)
  })

  it('GET /api/internal/repos respects repoOrder preference', async () => {
    const repo1Input: CreateRepoInput = {
      localPath: 'repo1',
      defaultBranch: 'main',
      cloneStatus: 'ready',
      clonedAt: Date.now(),
      isLocal: true,
    }
    const repo2Input: CreateRepoInput = {
      localPath: 'repo2',
      defaultBranch: 'main',
      cloneStatus: 'ready',
      clonedAt: Date.now(),
      isLocal: true,
    }
    const repo1 = createRepo(db, repo1Input)
    const repo2 = createRepo(db, repo2Input)

    settingsService.updateSettings({
      repoOrder: [repo2.id, repo1.id],
    })

    const res = await app.request('/api/internal/repos', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { repos: Array<{ id: number; localPath: string }> }
    expect(body.repos.length).toBe(2)
    expect(body.repos[0]?.id).toBe(repo2.id)
    expect(body.repos[1]?.id).toBe(repo1.id)
  })

  it('POST /api/internal/repos returns 401 without bearer token', async () => {
    const res = await app.request('/api/internal/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'https://github.com/owner/name' }),
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/internal/repos rejects a missing repoUrl, unknown keys, and invalid JSON', async () => {
    const bodies = [JSON.stringify({}), JSON.stringify({ repoUrl: 'https://github.com/owner/name', localPath: '/etc' }), 'not json']
    for (const body of bodies) {
      const res = await app.request('/api/internal/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      })
      expect(res.status).toBe(400)
    }
  })

  it('POST /api/internal/repos rejects URLs carrying credentials, queries or fragments and relative local paths', async () => {
    const bodies = [
      { repoUrl: 'https://user:token@github.com/owner/name' },
      { repoUrl: 'https://github.com/owner/name?token=x' },
      { repoUrl: 'https://github.com/owner/name#frag' },
      { localPath: 'relative/checkout' },
    ]
    for (const body of bodies) {
      const res = await app.request('/api/internal/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
    expect(listRepos(db)).toEqual([])
  })

  it('POST /api/internal/repos registers an existing absolute local checkout', async () => {
    const checkout = mkdtempSync(path.join(os.tmpdir(), 'internal-repo-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', checkout])
      const res = await app.request('/api/internal/repos', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ localPath: checkout }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { id: number; isLocal?: boolean }
      expect(getRepoById(db, body.id)).toBeTruthy()
    } finally {
      rmSync(checkout, { recursive: true, force: true })
    }
  })

  it('PATCH /api/internal/repos/:id renames only the display name and refuses the assistant repo', async () => {
    const repo = createRepo(db, {
      localPath: 'rename-me',
      defaultBranch: 'main',
      cloneStatus: 'ready',
      clonedAt: Date.now(),
      isLocal: true,
    })
    const patch = (id: string, body: unknown, auth = true) =>
      app.request(`/api/internal/repos/${id}`, {
        method: 'PATCH',
        headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    expect((await patch(String(repo.id), { name: '통합 예약 시스템' }, false)).status).toBe(401)
    const renamed = await patch(String(repo.id), { name: '  통합 예약 시스템  ' })
    expect(renamed.status).toBe(200)
    expect(((await renamed.json()) as { name?: string }).name).toBe('통합 예약 시스템')
    expect(getRepoById(db, repo.id)?.name).toBe('통합 예약 시스템')

    expect((await patch(String(repo.id), { name: '' })).status).toBe(200)
    expect(getRepoById(db, repo.id)?.name).toBeFalsy()
    expect((await patch('0', { name: 'x' })).status).toBe(400)
    expect((await patch('9999', { name: 'x' })).status).toBe(404)
    expect((await patch(String(repo.id), { name: 'x', localPath: '/etc' })).status).toBe(400)
  })

  it('POST /api/internal/repos returns the already registered repo for the same URL', async () => {
    const existing = createRepo(db, {
      repoUrl: 'https://github.com/owner/name',
      localPath: 'name',
      defaultBranch: 'main',
      cloneStatus: 'ready',
      clonedAt: Date.now(),
    })

    const res = await app.request('/api/internal/repos', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'https://github.com/owner/name.git' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { id: number }
    expect(body.id).toBe(existing.id)
  })

  it('GET /api/internal/repos/:id/schedules still works after adding repos route', async () => {
    const repoInput: CreateRepoInput = {
      localPath: 'test-repo',
      defaultBranch: 'main',
      cloneStatus: 'ready',
      clonedAt: Date.now(),
      isLocal: true,
    }
    const repo = createRepo(db, repoInput)

    const res = await app.request(`/api/internal/repos/${repo.id}/schedules`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { jobs: unknown[] }
    expect(body).toHaveProperty('jobs')
    expect(Array.isArray(body.jobs)).toBe(true)
  })
})