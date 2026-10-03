import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRuleFs } from '@rivetos/types'
import {
  PROJECT_RULE_BUDGET_MS,
  clearProjectRuleCache,
  createCachedProjectResolver,
  cwdFromSettings,
  planProjectRuleTag,
  resolveProjectOnNode,
} from './rule-project.js'

beforeEach(() => {
  clearProjectRuleCache()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('cwdFromSettings', () => {
  it('trims, and accepts only safe absolute paths', () => {
    expect(cwdFromSettings({ cwd: '  /srv/app  ' })).toBe('/srv/app')
    expect(cwdFromSettings({ cwd: 'C:\\dev\\App' })).toBe('C:\\dev\\App')
    for (const cwd of ['', '   ', 'relative', './x', '/a/../b', 7, null, undefined, '/' + 'x'.repeat(5000)]) {
      expect(cwdFromSettings({ cwd })).toBeUndefined()
    }
    expect(cwdFromSettings(undefined)).toBeUndefined()
  })
})

describe('resolveProjectOnNode (real filesystem)', () => {
  it('reads a real checkout: origin name, sanitized reason, no credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ros-rule-'))
    try {
      const repo = join(dir, 'checkout')
      mkdirSync(join(repo, '.git'), { recursive: true })
      mkdirSync(join(repo, 'packages', 'a'), { recursive: true })
      writeFileSync(
        join(repo, '.git', 'config'),
        '[remote "origin"]\n\turl = https://bot:ghp_SECRET@github.com/acme/Widget.git\n',
      )
      const hit = await resolveProjectOnNode(join(repo, 'packages', 'a'))
      expect(hit).toMatchObject({ value: 'widget', display: 'Widget', rule: 'git-remote' })
      expect(hit?.reason).toBe('git-remote: github.com/acme/Widget')
      expect(hit?.reason).not.toMatch(/ghp_|bot:/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createCachedProjectResolver', () => {
  it('caches per cwd, including negative results', async () => {
    const fs: ProjectRuleFs = { isDirectory: vi.fn(() => false), readFile: vi.fn(() => null) }
    const resolve = createCachedProjectResolver(fs)
    expect(await resolve('/srv/app')).toMatchObject({ value: 'app' })
    const calls = (fs.isDirectory as ReturnType<typeof vi.fn>).mock.calls.length
    expect(await resolve('/srv/app')).toMatchObject({ value: 'app' })
    expect(await resolve('/tmp')).toBeNull()
    expect(await resolve('/tmp')).toBeNull()
    expect((fs.isDirectory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })

  it('gives up after the budget when the filesystem hangs, and caches that', async () => {
    vi.useFakeTimers()
    const hung: ProjectRuleFs = {
      isDirectory: vi.fn(() => new Promise<boolean>(() => {})),
      readFile: vi.fn(() => new Promise<string | null>(() => {})),
    }
    const resolve = createCachedProjectResolver(hung)
    const pending = resolve('/mnt/dead-nfs/project')
    await vi.advanceTimersByTimeAsync(PROJECT_RULE_BUDGET_MS + 10)
    expect(await pending).toBeNull()
    expect(await resolve('/mnt/dead-nfs/project')).toBeNull()
    expect(hung.isDirectory).toHaveBeenCalledTimes(1)
  })
})

describe('planProjectRuleTag', () => {
  const HIT = {
    key: 'project' as const,
    value: 'app',
    display: 'App',
    rule: 'git-root' as const,
    reason: 'git-root: App',
  }

  it('uses the injected resolver for owner batches', async () => {
    const resolveProject = vi.fn(() => HIT)
    expect(await planProjectRuleTag({ cwd: '/srv/app' }, { resolveProject })).toBe(HIT)
  })

  it('ignores the resolver and the filesystem when allowFilesystem is false', async () => {
    const resolveProject = vi.fn(() => HIT)
    const hit = await planProjectRuleTag({ cwd: '/srv/code/thing' }, { resolveProject, allowFilesystem: false })
    expect(resolveProject).not.toHaveBeenCalled()
    expect(hit).toMatchObject({ rule: 'cwd-basename', value: 'thing' })
  })

  it('returns null (and logs) when the resolver throws, is disabled, or cwd is unusable', async () => {
    const log = vi.fn()
    const boom = vi.fn(() => {
      throw new Error('EIO')
    })
    expect(await planProjectRuleTag({ cwd: '/srv/app' }, { resolveProject: boom }, log)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EIO'))
    expect(await planProjectRuleTag({ cwd: '/srv/app' }, { resolveProject: null })).toBeNull()
    expect(await planProjectRuleTag({ cwd: 'nope' }, {})).toBeNull()
  })
})
