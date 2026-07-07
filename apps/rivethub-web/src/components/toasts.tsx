import type { JSX } from 'react'
import type { NotificationFrame } from '@rivetos/types'
import { useNotifications } from '../stores/notifications.js'

function frameTitle(frame: NotificationFrame): string {
  switch (frame.kind) {
    case 'escalation':
      return `⚠ escalation — ${frame.agentId}`
    case 'task.done':
      return `task ${frame.status}`
  }
}

function frameBody(frame: NotificationFrame): string {
  return frame.kind === 'escalation' ? frame.summary : frame.taskId
}

export function Toasts(): JSX.Element {
  const entries = useNotifications((s) => s.entries)
  const dismiss = useNotifications((s) => s.dismissToast)
  const toasts = entries.filter((e) => e.toast)

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((e) => (
        <div
          key={e.id}
          className="pointer-events-auto rounded-lg border border-red/50 bg-panel-2 px-4 py-3 shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-mono text-xs font-semibold text-red">{frameTitle(e.frame)}</div>
              <div className="mt-1 truncate text-sm text-ink">{frameBody(e.frame)}</div>
              <div className="mt-1 font-mono text-[10px] text-ink-dim">
                {new Date(e.frame.ts).toLocaleTimeString()} · durable record in /api/outcomes
              </div>
            </div>
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
