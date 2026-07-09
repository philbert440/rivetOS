import { useState, type JSX } from 'react'
import { X } from 'lucide-react'
import type { AskQuestion } from '../lib/ask-user.js'

/**
 * Ask card — pops up from the top of the composer when the agent prompts the
 * user (AskUserQuestion / ask_user / ask_user_question). Headless CLI ask
 * tools don't block, so the pick is simply sent as the next user turn.
 *
 * Fast path: ONE single-select question answers on click. Multi-select or
 * multi-question shows checkboxes/radios plus a Send button; multi-question
 * answers are prefixed with the question's header ("Auth method: JWT") so the
 * agent can match them up.
 */
export function AskUserCard(props: {
  questions: AskQuestion[]
  disabled?: boolean
  onAnswer: (text: string) => void
  onDismiss: () => void
}): JSX.Element | null {
  // label selections per question index
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  if (props.questions.length === 0) return null

  const single = props.questions.length === 1 && !props.questions[0].multiSelect

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((p) => {
      const cur = p[qi] ?? []
      if (!multi) return { ...p, [qi]: [label] }
      return { ...p, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }

  const answers = props.questions
    .map((q, qi) => ({ q, labels: picked[qi] ?? [] }))
    .filter((a) => a.labels.length > 0)
  const canSend = answers.length > 0

  const send = (): void => {
    if (!canSend) return
    const text =
      props.questions.length === 1
        ? answers[0].labels.join(', ')
        : answers
            .map((a) => {
              const prefix = a.q.header ?? a.q.question
              return prefix ? `${prefix}: ${a.labels.join(', ')}` : a.labels.join(', ')
            })
            .join('\n')
    props.onAnswer(text)
    setPicked({})
  }

  return (
    <div
      role="group"
      aria-label="Rivet is asking"
      className="mb-2 rounded-xl border border-em-dim/50 bg-panel shadow-lg shadow-bg/40"
    >
      <div className="flex items-center justify-between border-b border-line/60 px-3 py-1.5">
        <span className="font-mono text-[11px] text-em">Rivet is asking</span>
        <button
          type="button"
          onClick={props.onDismiss}
          aria-label="dismiss question"
          title="dismiss"
          className="rounded p-0.5 text-ink-dim hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="max-h-72 space-y-3 overflow-y-auto px-3 py-2.5">
        {props.questions.map((q, qi) => (
          <div key={qi}>
            {q.question && <div className="mb-1.5 text-sm text-ink">{q.question}</div>}
            {!q.question && q.header && <div className="mb-1.5 text-sm text-ink">{q.header}</div>}
            <div className="flex flex-col gap-1">
              {q.options.map((o) => {
                const selected = (picked[qi] ?? []).includes(o.label)
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={props.disabled}
                    onClick={() =>
                      single ? props.onAnswer(o.label) : toggle(qi, o.label, q.multiSelect)
                    }
                    className={`rounded-lg border px-3 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
                      selected
                        ? 'border-em bg-em-dim/25 text-em'
                        : 'border-line bg-panel-2/40 text-ink hover:border-em-dim hover:bg-em-dim/10'
                    }`}
                  >
                    <span className={selected ? 'text-em' : 'text-ink'}>{o.label}</span>
                    {o.description && (
                      <span className="mt-0.5 block text-[11px] leading-snug text-ink-dim">
                        {o.description}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {!single && (
        <div className="flex justify-end border-t border-line/60 px-3 py-1.5">
          <button
            type="button"
            disabled={!canSend || props.disabled}
            onClick={send}
            className="rounded border border-em bg-em-dim/20 px-3 py-1 text-xs text-em hover:bg-em-dim/40 disabled:opacity-40"
          >
            Send answer{answers.length > 1 ? 's' : ''}
          </button>
        </div>
      )}
    </div>
  )
}
