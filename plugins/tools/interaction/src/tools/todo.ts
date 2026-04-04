/**
 * todo — Session-scoped task list for tracking multi-step plans.
 */

import type { Tool, ToolContext } from '@rivetos/types'

type TaskStatus = 'pending' | 'in_progress' | 'done'

interface Task {
  id: number
  text: string
  status: TaskStatus
}

const STATUS_ICONS: Record<TaskStatus, string> = {
  done: '✅',
  in_progress: '🔧',
  pending: '  ',
}

export function createTodoTool(): Tool {
  const tasks = new Map<number, Task>()
  let nextId = 1

  return {
    name: 'todo',
    description:
      'Session-scoped task list. Track multi-step plans with add/update/complete/remove/list operations.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'update', 'complete', 'remove', 'list'],
          description: 'Operation to perform',
        },
        task: {
          type: 'string',
          description: 'Task description (required for add)',
        },
        id: {
          type: 'number',
          description: 'Task ID (required for update, complete, remove)',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done'],
          description: 'New status (for update)',
        },
        new_text: {
          type: 'string',
          description: 'New task description (for update)',
        },
      },
      required: ['operation'],
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(
      args: Record<string, unknown>,
      _signal?: AbortSignal,
      _context?: ToolContext,
    ): Promise<string> {
      const operation = (args.operation as string | undefined) ?? ''

      switch (operation) {
        case 'add': {
          const text = (args.task as string | undefined) ?? ''.trim()
          if (!text) return 'Error: task text is required for add'

          const id = nextId++
          tasks.set(id, { id, text, status: 'pending' })
          return `Added task #${id}: ${text}`
        }

        case 'update': {
          const id = Number(args.id)
          if (!id || !Number.isInteger(id)) return 'Error: valid task id is required for update'

          const task = tasks.get(id)
          if (!task) return `Error: task #${id} not found`

          if (args.new_text !== undefined) {
            const newText = (args.new_text as string | undefined).trim()
            if (newText) task.text = newText
          }
          if ((args.status as string | undefined) !== undefined) {
            const status = String(args.status as string | undefined) as TaskStatus
            if (['pending', 'in_progress', 'done'].includes(status)) {
              task.status = status
            } else {
              return `Error: invalid status "${args.status as string | undefined}" — use pending, in_progress, or done`
            }
          }

          return `Updated task #${id}: ${task.text} [${task.status}]`
        }

        case 'complete': {
          const id = Number(args.id)
          if (!id || !Number.isInteger(id)) return 'Error: valid task id is required for complete'

          const task = tasks.get(id)
          if (!task) return `Error: task #${id} not found`

          task.status = 'done'
          return `Completed task #${id}: ${task.text}`
        }

        case 'remove': {
          const id = Number(args.id)
          if (!id || !Number.isInteger(id)) return 'Error: valid task id is required for remove'

          if (!tasks.has(id)) return `Error: task #${id} not found`

          tasks.delete(id)
          return `Removed task #${id}`
        }

        case 'list': {
          if (tasks.size === 0) return 'No tasks yet.'

          const sorted = [...tasks.values()].sort((a, b) => a.id - b.id)
          const doneCount = sorted.filter((t) => t.status === 'done').length
          const header = `Tasks (${doneCount}/${sorted.length} done):`

          const lines = sorted.map((t) => {
            const icon = STATUS_ICONS[t.status]
            return `[${icon}] #${t.id} ${t.text}`
          })

          return [header, ...lines].join('\n')
        }

        default:
          return `Error: unknown operation "${operation}" — use add, update, complete, remove, or list`
      }
    },
  }
}
