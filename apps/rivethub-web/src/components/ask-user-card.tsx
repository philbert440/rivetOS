import { useRef, useState, type JSX } from 'react'
import { MessageSquare, X } from 'lucide-react'
import {
  askCardMode,
  askErrorMessage,
  composeAskAnswer,
  structuredAskAnswers,
  type AskQuestion,
  type AskScreen,
} from '../lib/ask-user.js'

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
export type AskStructuredAnswer = { question: number; labels: string[]; other?: string }

export function AskUserCard(props: {
  questions: AskQuestion[]
  disabled?: boolean
  /** Resolves when the answer was actually sent — the card keeps its state
   *  (the only retry surface) until then; a rejected send leaves it intact. */
  onAnswer: (text: string) => Promise<void>
  /**
   * Bound harness path: one answers[i] per question. When set, submit uses
   * this instead of composing a user-turn string. The card stays until the
   * parent drops `questions` (resolved frame).
   */
  onAnswerStructured?: (answers: AskStructuredAnswer[]) => Promise<void>
  onDismiss: () => void
  /** Focus the composer textarea ("chat about it"). */
  onFocusComposer?: () => void
  /** Screen-read picker position. Absent on store-derived AskUserQuestion. */
  screen?: AskScreen
}): JSX.Element | null {
  // label selections per question index
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [own, setOwn] = useState('')
  const [questionText, setQuestionText] = useState<Record<number, string>>({})
  const [sending, setSending] = useState(false)
  // one answer in flight at a time — the async clear made double-click a
  // double-send (#578 audit); the sync clear used to make this free
  const inFlight = useRef(false)
  if (props.questions.length === 0) return null

  const screen = props.screen
  const only = props.questions.length === 1 ? props.questions[0] : undefined
  const cardMode = only ? askCardMode(only, screen) : 'answer'
  const hideFreeText = (screen !== undefined && screen.total > 1) || cardMode !== 'answer'
  // A single-select screen question submits on the option click (den presses
  // the digit) — a footer with a never-enabled button would just be noise.
  // (only for a multi-question picker: a single screen question still takes a typed answer)
  const hideSubmit =
    cardMode !== 'answer' ||
    (screen !== undefined && screen.total > 1 && only !== undefined && !only.multiSelect)
  const single =
    props.questions.length === 1 && !props.questions[0].multiSelect && cardMode === 'answer'

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((p) => {
      const cur = p[qi] ?? []
      if (!multi) return { ...p, [qi]: [label] }
      return { ...p, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })
  }

  const [error, setError] = useState<string | undefined>()
  const composed = composeAskAnswer(props.questions, picked, own)

  const structured = (picks: Record<number, string[]>): AskStructuredAnswer[] =>
    structuredAskAnswers(props.questions, picks, questionText)

  const submit = (extra?: Record<number, string[]>): void => {
    const picks = extra ?? picked
    if (inFlight.current) return
    if (props.onAnswerStructured) {
      if (structured(picks).some((a) => !a.labels.length && !a.other)) return
      inFlight.current = true
      setSending(true)
      void props.onAnswerStructured(structured(picks)).then(
        () => {
          inFlight.current = false
          setSending(false)
        },
        (err: unknown) => {
          inFlight.current = false
          setSending(false)
          setError(askErrorMessage(err))
        },
      )
      return
    }
    const text = extra ? composeAskAnswer(props.questions, extra, own) : composed
    if (!text) return
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
        <span className="font-mono text-[11px] text-em">
          {screen
            ? `Question ${String(screen.current + 1)} of ${String(screen.total)}`
            : 'Rivet is asking'}
        </span>
        <div className="flex items-center gap-1.5">
          {props.onFocusComposer && (
            <button
              type="button"
              onClick={() => {
                props.onFocusComposer?.()
                props.onDismiss()
              }}
              title="chat about it — reply freely below instead of picking"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-dim hover:text-em"
            >
              <MessageSquare className="size-3" /> chat about it
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              props.onFocusComposer?.()
              props.onDismiss()
            }}
            aria-label="dismiss question"
            title="chat about it"
            className="rounded p-0.5 text-ink-dim hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <div className="max-h-72 space-y-3 overflow-y-auto px-3 py-2.5">
        {screen &&
          cardMode === 'answer' &&
          screen.total > 1 &&
          screen.current < screen.total - 1 && (
            <div className="font-mono text-[10px] text-ink-dim">
              answering here moves the terminal to the next question
            </div>
          )}
        {props.questions.map((q, qi) => {
          const labelId = `ask-q-${String(qi)}`
          const hintId = `ask-q-hint-${String(qi)}`
          const title = q.question ?? q.header
          const qMode = askCardMode(q, only ? screen : undefined)
          return (
            <div key={qi}>
              {title && (
                <div id={labelId} className="mb-1.5 text-sm text-ink">
                  {title}
                </div>
              )}
              {q.multiSelect && qMode === 'answer' && (
                <div id={hintId} className="mb-1 font-mono text-[10px] text-ink-dim">
                  select all that apply
                </div>
              )}
              {qMode === 'no-options' ? (
                <div className="font-mono text-[11px] text-ink-dim">
                  options not visible — answer in the terminal
                </div>
              ) : (
                <>
                  {qMode === 'terminal-only' && (
                    <div className="mb-1 font-mono text-[11px] text-ink-dim">
                      answer this one in the terminal
                    </div>
                  )}
                  <div
                    className="flex flex-col gap-1"
                    role={q.multiSelect ? 'group' : 'radiogroup'}
                    aria-labelledby={title ? labelId : undefined}
                    aria-describedby={q.multiSelect && qMode === 'answer' ? hintId : undefined}
                  >
                    {q.options.map((o) => {
                      const selected = (picked[qi] ?? []).includes(o.label)
                      return (
                        <button
                          key={o.label}
                          type="button"
                          role={q.multiSelect ? 'checkbox' : 'radio'}
                          aria-checked={selected}
                          disabled={props.disabled || sending || qMode === 'terminal-only'}
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
                </>
              )}
              {props.onAnswerStructured && !hideFreeText && qMode === 'answer' && (
                <input
                  value={questionText[qi] ?? ''}
                  onChange={(e) =>
                    setQuestionText((current) => ({ ...current, [qi]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      submit()
                    }
                  }}
                  disabled={props.disabled || sending}
                  aria-label={`Type your own answer to question ${String(qi + 1)}`}
                  placeholder="type your own answer…"
                  className="mt-2 w-full rounded border border-line bg-panel-2/40 px-2 py-1 text-xs text-ink"
                />
              )}
            </div>
          )
        })}
      </div>
      {!hideSubmit && (
        <div className="flex items-center gap-2 border-t border-line/60 px-3 py-1.5">
          {!hideFreeText && !props.onAnswerStructured && (
            <input
              value={own}
              onChange={(e) => setOwn(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              disabled={props.disabled || sending}
              aria-label="Type your own answer"
              placeholder="type your own answer…"
              className="min-w-0 flex-1 rounded border border-line bg-panel-2/40 px-2 py-1 text-xs text-ink placeholder:text-ink-dim focus:border-em-dim focus:outline-none disabled:opacity-40"
            />
          )}
          <button
            type="button"
            disabled={
              (props.onAnswerStructured
                ? structured(picked).some((a) => !a.labels.length && !a.other)
                : !composed) ||
              props.disabled ||
              sending
            }
            onClick={() => submit()}
            className="rounded border border-em bg-em-dim/20 px-3 py-1 text-xs text-em hover:bg-em-dim/40 disabled:opacity-40"
          >
            {sending ? 'sending…' : own.trim() ? 'Answer' : 'Send answers'}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red">
          {error}
        </p>
      )}
    </div>
  )
}
