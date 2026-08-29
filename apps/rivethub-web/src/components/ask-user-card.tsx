import { useRef, useState, type JSX } from 'react'
import { MessageSquare, X } from 'lucide-react'
import { composeAskAnswer, type AskQuestion } from '../lib/ask-user.js'

/**
 * Ask card — pops up from the top of the composer when the agent prompts the
 * user (AskUserQuestion / ask_user / ask_user_question). Headless CLI ask
 * tools don't block, so the answer is simply sent as the next user turn.
 *
 * Submit semantics live in composeAskAnswer (pure, tested): picks and the
 * free-text row COMBINE — typing your own words never silently drops a
 * selection, and vice versa. Fast path: ONE single-select question answers on
 * click, combining any typed text. "Chat about it" focuses the composer
 * (typing + sending there retires the card — that IS chatting about it).
 */
export function AskUserCard(props: {
  questions: AskQuestion[]
  disabled?: boolean
  /** Resolves when the answer was actually sent — the card keeps its state
   *  (the only retry surface) until then; a rejected send leaves it intact. */
  onAnswer: (text: string) => Promise<void>
  onDismiss: () => void
  /** Focus the composer textarea ("chat about it"). */
  onFocusComposer?: () => void
}): JSX.Element | null {
  // label selections per question index
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [own, setOwn] = useState('')
  // one answer in flight at a time — the async clear made double-click a
  // double-send (#578 audit); the sync clear used to make this free
  const inFlight = useRef(false)
  if (props.questions.length === 0) return null

  const single = props.questions.length === 1 && !props.questions[0].multiSelect

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((p) => {
      const cur = p[qi] ?? []
      if (!multi) return { ...p, [qi]: [label] }
      return { ...p, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }

  const composed = composeAskAnswer(props.questions, picked, own)

  const submit = (extra?: Record<number, string[]>): void => {
    const text = extra ? composeAskAnswer(props.questions, extra, own) : composed
    if (!text || inFlight.current) return
    inFlight.current = true
    void props.onAnswer(text).then(
      () => {
        inFlight.current = false
        setPicked({})
        setOwn('')
      },
      () => {
        inFlight.current = false // send failed: composer shows the error, card keeps state for retry
      },
    )
  }

  return (
    <div
      role="group"
      aria-label="Rivet is asking"
      className="mb-2 rounded-xl border border-em-dim/50 bg-panel shadow-lg shadow-bg/40"
    >
      <div className="flex items-center justify-between border-b border-line/60 px-3 py-1.5">
        <span className="font-mono text-[11px] text-em">Rivet is asking</span>
        <div className="flex items-center gap-1.5">
          {props.onFocusComposer && (
            <button
              type="button"
              onClick={props.onFocusComposer}
              title="chat about it — reply freely below instead of picking"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:text-em"
            >
              <MessageSquare className="size-3" /> chat about it
            </button>
          )}
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
      </div>
      <div className="max-h-72 space-y-3 overflow-y-auto px-3 py-2.5">
        {props.questions.map((q, qi) => {
          const labelId = `ask-q-${String(qi)}`
          const hintId = `ask-q-hint-${String(qi)}`
          const title = q.question ?? q.header
          return (
            <div key={qi}>
              {title && (
                <div id={labelId} className="mb-1.5 text-sm text-ink">
                  {title}
                </div>
              )}
              {q.multiSelect && (
                <div id={hintId} className="mb-1 font-mono text-[10px] text-ink-dim">
                  select all that apply
                </div>
              )}
              <div
                className="flex flex-col gap-1"
                role={q.multiSelect ? 'group' : 'radiogroup'}
                aria-labelledby={title ? labelId : undefined}
                aria-describedby={q.multiSelect ? hintId : undefined}
              >
                {q.options.map((o) => {
                  const selected = (picked[qi] ?? []).includes(o.label)
                  return (
                    <button
                      key={o.label}
                      type="button"
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={selected}
                      disabled={props.disabled}
                      onClick={() => {
                        // Fast path: one bare single-select click answers now;
                        // typed text makes the click COMBINE instead of drop it.
                        if (single) {
                          submit({ 0: [o.label] })
                          return
                        }
                        toggle(qi, o.label, q.multiSelect)
                      }}
                      className={`flex items-start gap-2 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
                        selected
                          ? 'border-em bg-em-dim/25 text-em'
                          : 'border-line bg-panel-2/40 text-ink hover:border-em-dim hover:bg-em-dim/10'
                      }`}
                    >
                      {/* affordance: square = pick many, circle = pick one */}
                      <span
                        aria-hidden
                        className={`mt-0.5 inline-block size-3 shrink-0 border ${
                          q.multiSelect ? 'rounded-[3px]' : 'rounded-full'
                        } ${selected ? 'border-em bg-em' : 'border-ink-dim bg-transparent'}`}
                      />
                      <span className="min-w-0">
                        <span className={selected ? 'text-em' : 'text-ink'}>{o.label}</span>
                        {o.description && (
                          <span className="mt-0.5 block text-[11px] leading-snug text-ink-dim">
                            {o.description}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-2 border-t border-line/60 px-3 py-1.5">
        <input
          value={own}
          onChange={(e) => setOwn(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          disabled={props.disabled}
          aria-label="Type your own answer"
          placeholder="type your own answer…"
          className="min-w-0 flex-1 rounded border border-line bg-panel-2/40 px-2 py-1 text-xs text-ink placeholder:text-ink-dim focus:border-em-dim focus:outline-none disabled:opacity-40"
        />
        <button
          type="button"
          disabled={!composed || props.disabled}
          onClick={() => submit()}
          className="rounded border border-em bg-em-dim/20 px-3 py-1 text-xs text-em hover:bg-em-dim/40 disabled:opacity-40"
        >
          {own.trim() ? 'Answer' : 'Send answers'}
        </button>
      </div>
    </div>
  )
}
