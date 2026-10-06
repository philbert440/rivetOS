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
})
