import type { JSX } from 'react'
import { ShieldQuestion } from 'lucide-react'
import type { ApprovalDecision } from '@rivetos/types'
import type { PendingApproval } from '../stores/chat.js'
import { humanToolTitle } from '../lib/tool-titles.js'

/**
 * Tool-approval prompt for a harness that surfaces its permission gate on the
 * wire. Rendered only when the driver reports `approvals: true` — the page
 * gates on the capability flag, so a driver whose prompts live inside its own
 * TUI (`claude-code`, always) never shows this. Decisions post to
 * `POST /api/harness-sessions/:enc/approvals/:requestId`; the resolution is
 * broadcast to every subscriber, so a second client's card clears itself.
 */
export function HarnessApprovalCard(props: {
  pending: PendingApproval[]
  disabled?: boolean
  onDecide: (requestId: string, decision: ApprovalDecision) => void
}): JSX.Element | null {
  if (props.pending.length === 0) return null
  const request = props.pending[0]
  const args =
    request.input && typeof request.input === 'object' && !Array.isArray(request.input)
      ? (request.input as Record<string, unknown>)
      : undefined

  const choices: { label: string; decision: ApprovalDecision; accent: boolean }[] = [
    { label: 'Allow', decision: 'allow', accent: true },
    { label: 'Allow for session', decision: 'allow-session', accent: false },
    { label: 'Deny', decision: 'deny', accent: false },
  ]

  return (
    <div
      role="group"
      aria-label="harness approval request"
      className="mb-2 rounded-xl border border-em-dim/50 bg-panel px-3 py-2 shadow-lg shadow-bg/40"
    >
      <div className="flex items-center gap-2 text-xs text-ink">
        <ShieldQuestion className="size-3.5 shrink-0 text-em" aria-hidden />
        <span className="min-w-0 truncate">{humanToolTitle(request.name, args)}</span>
        {props.pending.length > 1 && (
          <span className="shrink-0 font-mono text-[10px] text-ink-dim">
            +{props.pending.length - 1} waiting
          </span>
        )}
      </div>
      {request.reason && <div className="mt-1 text-[11px] text-ink-dim">{request.reason}</div>}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {choices.map((c) => (
          <button
            key={c.decision}
            disabled={props.disabled}
            onClick={() => props.onDecide(request.requestId, c.decision)}
            className={`rounded border px-2 py-1 font-mono text-[11px] disabled:opacity-50 ${
              c.accent
                ? 'border-em text-em hover:bg-em/10'
                : 'border-line text-ink-dim hover:border-em hover:text-em'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
