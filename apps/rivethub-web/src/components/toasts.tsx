import type { JSX } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { NotificationFrame } from '@rivetos/types'
import { useNotifications } from '../stores/notifications.js'

function frameTitle(frame: NotificationFrame): string {
  switch (frame.kind) {
    case 'escalation':
      return `⚠ escalation — ${frame.agentId}`
    case 'task.done':
      return `task ${frame.status}`
    case 'workflow.gate':
      return `⏸ gate · ${frame.workflowId}`
  }
}

function frameBody(frame: NotificationFrame): string {
  switch (frame.kind) {
    case 'escalation':
      return frame.summary
    case 'task.done':
      return `${frame.taskId} — ${frame.status}`
    case 'workflow.gate':
      return frame.prompt?.trim()
        ? `${frame.label}: ${frame.prompt}`
        : `${frame.label} · ${frame.runId}`
  }
}

function frameHref(frame: NotificationFrame): string {
  switch (frame.kind) {
    case 'escalation':
      return frame.href
    case 'task.done':
      return `/tasks/${frame.taskId}`
    case 'workflow.gate':
      return frame.href || `/workflows/runs/${frame.runId}`
  }
}

export function Toasts(): JSX.Element {
  const entries = useNotifications((s) => s.entries)
  const dismiss = useNotifications((s) => s.dismissToast)
  const navigate = useNavigate()
  const toasts = entries.filter((e) => e.toast)

  const open = (entry: { id: string; frame: NotificationFrame }): void => {
    dismiss(entry.id) // navigating consumed it; don't let it linger
    void navigate({ to: frameHref(entry.frame) })
  }

  // Red chrome is for bad news only — completed task.done and workflow gates
  // use emerald (#303 / slice C).
  const severity = (frame: NotificationFrame): 'red' | 'em' => {
    if (frame.kind === 'escalation') return 'red'
    if (frame.kind === 'task.done' && frame.status !== 'completed') return 'red'
    return 'em'
  }

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((e) => (
        <div
          key={e.id}
          className={`pointer-events-auto rounded-lg border bg-panel-2 px-4 py-3 shadow-lg ${
            severity(e.frame) === 'red' ? 'border-red/50' : 'border-em/50'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <button className="min-w-0 text-left" onClick={() => open(e)}>
              <div
                className={`font-mono text-xs font-semibold ${
                  severity(e.frame) === 'red' ? 'text-red' : 'text-em'
                }`}
              >
                {frameTitle(e.frame)}
              </div>
              <div className="mt-1 truncate text-sm text-ink">{frameBody(e.frame)}</div>
              <div className="mt-1 font-mono text-[10px] text-ink-dim">
                {new Date(e.frame.ts).toLocaleTimeString()}
                {e.frame.kind === 'workflow.gate'
                  ? ' · resume from run detail'
                  : ' · durable record in /api/outcomes'}
              </div>
            </button>
            <button
              onClick={() => dismiss(e.id)}
              className="text-ink-dim hover:text-ink"
              aria-label="dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
