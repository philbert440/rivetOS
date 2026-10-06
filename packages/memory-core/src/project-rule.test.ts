import { describe, expect, it } from 'vitest'
import { isTaskSandboxCwd, planProjectRuleTag } from './project-rule.js'

describe('isTaskSandboxCwd', () => {
  it('matches a cowork task dir and its outputs child, including windows separators', () => {
    expect(isTaskSandboxCwd('/Users/me/Library/Application Support/Claude/local-agent-mode-sessions/local_abc')).toBe(
      true,
    )
    expect(
      isTaskSandboxCwd('/Users/me/Library/Application Support/Claude/local-agent-mode-sessions/local_abc/outputs'),
    ).toBe(true)
    expect(
      isTaskSandboxCwd(
        'C:\\Users\\me\\AppData\\Claude\\local-agent-mode-sessions\\local_abc\\outputs\\',
      ),
    ).toBe(true)
    expect(isTaskSandboxCwd('/work/acmeapp')).toBe(false)
    expect(isTaskSandboxCwd('/work/acmeapp/outputs')).toBe(false)
    expect(isTaskSandboxCwd('/tmp/local_notes/src')).toBe(false)
    expect(isTaskSandboxCwd('/private/var/empty')).toBe(true)
    expect(isTaskSandboxCwd('/private/var/empty/')).toBe(true)
    expect(
      isTaskSandboxCwd(
        '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions/acct/org/af1d0ad3/outputs',
      ),
    ).toBe(true)
  })

  it('does not plan a project tag for a task sandbox', async () => {
    const sandbox = {
      key: 'project' as const,
      value: 'should-not-run',
      rule: 'cwd-basename' as const,
    }
    const hit = await planProjectRuleTag({ cwd: '/tmp/local_task/outputs' }, { resolveProject: () => sandbox })
    expect(hit).toBeNull()
    const repo = { key: 'project' as const, value: 'acmeapp', rule: 'cwd-basename' as const }
    expect(await planProjectRuleTag({ cwd: '/tmp/acmeapp' }, { resolveProject: () => repo })).toEqual(repo)
  })

  it('does not tag a cowork cwd, and uses attached folders instead', async () => {
    const repo = { key: 'project' as const, value: 'acmeapp', rule: 'cwd-basename' as const }
    const resolveProject = (cwd: string) => (cwd === '/work/acmeapp' ? repo : null)
    expect(
      await planProjectRuleTag(
        { cwd: '/private/var/empty', source: 'cowork-hook' },
        { resolveProject },
      ),
    ).toBeNull()
    expect(
      await planProjectRuleTag(
        { cwd: '/Users/me/Library/Application Support/Claude/local-agent-mode-sessions/org/af1d0ad3/outputs' },
        { resolveProject, channel: 'cowork' },
      ),
    ).toBeNull()
    expect(
      await planProjectRuleTag(
        {
          cwd: '/private/var/empty',
          source: 'cowork-transcript',
          folders: ['/private/var/empty', '/work/acmeapp'],
        },
        { resolveProject },
      ),
    ).toEqual(repo)
    expect(
      await planProjectRuleTag({ folders: ['/work/acmeapp'] }, { resolveProject, channel: 'cowork' }),
    ).toEqual(repo)
  })
})
