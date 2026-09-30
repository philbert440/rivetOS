import { describe, expect, it } from 'vitest'
import { linksFromTaskRows } from './delegated-session-links.js'

describe('linksFromTaskRows', () => {
  it('maps a registered row, including one that already finished', () => {
    expect(
      linksFromTaskRows([
        {
          id: 'dead',
          parentTaskId: 'parent-task',
          executorTarget: 'claude-code',
          spec: {
            spawnedSessionId: 'sess',
            parentSessionId: 'claude-code:parent',
            spawnedAgentName: 'reviewer',
            spawnedModel: 'opus',
            owner: 'coco',
          },
        },
      ]),
    ).toEqual([
      {
        taskId: 'dead',
        parentTaskId: 'parent-task',
        spawnedSessionId: 'sess',
        parentSessionId: 'claude-code:parent',
        agentName: 'reviewer',
        model: 'opus',
        owner: 'coco',
        harnessId: 'claude-code',
      },
    ])
  })

  it('skips a row that never registered a session', () => {
    expect(
      linksFromTaskRows([
        { id: 'fresh', spec: { parentSessionId: 'claude-code:forged' } },
        { id: 'blank', spec: { spawnedSessionId: '  ' } },
      ]),
    ).toEqual([])
  })
})
