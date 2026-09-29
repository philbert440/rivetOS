import { describe, expect, it } from 'vitest'
import type { TaskEvent } from '@rivetos/types'
import { buildArgs, type SpawnTurnFlags } from './spawn-turn.js'
import {
  createPermissionPromptTool,
  parsePermissionPrompts,
  permissionDecisionText,
  permissionPromptToolId,
  type PermissionPrompter,
} from './permission-prompt.js'

const flags = (over: Partial<SpawnTurnFlags> = {}): SpawnTurnFlags => ({
  binary: 'claude',
  modelId: '',
  toolsArg: 'default',
  effort: 'medium',
  permissionMode: 'default',
  excludeDynamicSections: true,
  systemText: '',
  ...over,
})

describe('permission prompt flags', () => {
  it('unset is byte-identical: no permission-prompts flag', () => {
    const args = buildArgs(flags())
    expect(args).not.toContain('--permission-prompts')
    expect(args).not.toContain('--permission-prompt-tool')
    expect(args).toContain('--permission-mode')
  })

  it('none denies immediately and does not name a tool', () => {
    const args = buildArgs(flags({ permissionPrompts: 'none' }))
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none')
    expect(args).not.toContain('--permission-prompt-tool')
  })

  it('ui points the CLI at the embedded request_permission tool', () => {
    const args = buildArgs(flags({ permissionPrompts: 'ui' }))
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('host')
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe(
      'mcp__rivetos__request_permission',
    )
    expect(permissionPromptToolId()).toBe('mcp__rivetos__request_permission')
  })

  it('parsePermissionPrompts keeps only ui and none', () => {
    expect(parsePermissionPrompts(undefined)).toBeUndefined()
    expect(parsePermissionPrompts(null)).toBeUndefined()
    expect(parsePermissionPrompts('')).toBeUndefined()
    expect(parsePermissionPrompts('ask')).toBeUndefined()
    expect(parsePermissionPrompts('ui')).toBe('ui')
    expect(parsePermissionPrompts('none')).toBe('none')
  })
})

describe('request_permission tool', () => {
  function prompter(answer: Awaited<ReturnType<PermissionPrompter['ask']>>): PermissionPrompter {
    return { ask: () => Promise.resolve(answer) }
  }

  it('returns an allow object and emits both events', async () => {
    const events: TaskEvent[] = []
    const tool = createPermissionPromptTool({
      taskId: 'task-1',
      prompter: prompter({ behavior: 'allow', decision: 'allow' }),
      emit: (event) => events.push(event),
    })
    const text = await tool.execute({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu' })
    expect(text).toBe(permissionDecisionText({ behavior: 'allow' }))
    expect(JSON.parse(text as string)).toEqual({ behavior: 'allow' })
    expect(events.map((event) => event.type)).toEqual(['approval-request', 'approval-resolved'])
    expect(events[0]).toMatchObject({
      type: 'approval-request',
      taskId: 'task-1',
      name: 'Bash',
      input: { command: 'ls' },
      toolCallId: 'tu',
    })
    expect(events[1]).toMatchObject({ type: 'approval-resolved', decision: 'allow' })
  })

  it('deny always carries a message', async () => {
    const tool = createPermissionPromptTool({
      taskId: 'task-1',
      prompter: prompter({ behavior: 'deny', decision: 'timeout', message: 'timed out' }),
      emit: () => undefined,
    })
    const text = await tool.execute({ tool_name: 'Edit', input: { file: 'a' } })
    expect(JSON.parse(text as string)).toEqual({ behavior: 'deny', message: 'timed out' })
  })

  it('a missing tool name denies without calling the prompter', async () => {
    let called = false
    const tool = createPermissionPromptTool({
      taskId: 'task-1',
      prompter: {
        ask: () => {
          called = true
          return Promise.resolve({ behavior: 'allow', decision: 'allow' })
        },
      },
      emit: () => undefined,
    })
    const text = await tool.execute({ input: {} })
    expect(called).toBe(false)
    expect(JSON.parse(text as string).behavior).toBe('deny')
  })

  it('a prompter failure denies', async () => {
    const events: TaskEvent[] = []
    const tool = createPermissionPromptTool({
      taskId: 'task-1',
      prompter: {
        ask: () => Promise.reject(new Error('broker down')),
      },
      emit: (event) => events.push(event),
    })
    const text = await tool.execute({ tool_name: 'Bash', input: {} })
    expect(JSON.parse(text as string)).toMatchObject({ behavior: 'deny' })
    expect(events[1]).toMatchObject({ type: 'approval-resolved', decision: 'deny' })
  })
})
