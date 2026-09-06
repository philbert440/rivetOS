/**
 * TUI keystroke translation for AskUserQuestion and permission prompts.
 *
 * Claude sequences are spike-verified on Claude Code 2.1.263
 * (`/rivet-shared/fidelity/notes/claude-tui-keys-2.1.263.md`). Options past
 * digit 9 were not observed — we refuse them.
 */

import { HarnessError, type ApprovalDecision, type HarnessAskQuestion } from '@rivetos/types'

/** Spike-verified Claude Code TUI. See claude-tui-keys-2.1.263.md. */
export const CLAUDE_TUI_KEYS_VERIFIED = '2.1.263'

const MAX_DIGIT_OPTIONS = 9

export type PromptAnswer = { question: number; labels: string[]; other?: string }

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function bad(message: string): never {
  throw new HarnessError('bad_request', message)
}

function optionDigit(questions: HarnessAskQuestion[], qi: number, label: string): string {
  const q = questions[qi]
  if (!q) bad(`unknown question index ${String(qi)}`)
  if (q.options.length > MAX_DIGIT_OPTIONS) {
    bad(`question ${String(qi)} has more than ${String(MAX_DIGIT_OPTIONS)} options`)
  }
  const idx = q.options.findIndex((o) => o.label === label)
  if (idx < 0) bad(`unknown label ${JSON.stringify(label)}`)
  if (idx >= MAX_DIGIT_OPTIONS) {
    bad(`option ${JSON.stringify(label)} is beyond digit 9`)
  }
  return String(idx + 1)
}

function otherDigit(q: HarnessAskQuestion, qi: number): string {
  if (q.options.length > MAX_DIGIT_OPTIONS) {
    bad(`question ${String(qi)} has more than ${String(MAX_DIGIT_OPTIONS)} options`)
  }
  // "Type something." is k+1. Digit 10 does not exist.
  if (q.options.length >= MAX_DIGIT_OPTIONS) {
    bad(`question ${String(qi)} Other row is beyond digit 9`)
  }
  return String(q.options.length + 1)
}

/**
 * One PTY write per keystroke group, in TUI order.
 * `\t` = Tab, `\r` = Enter, digits as ASCII, typed Other text verbatim.
 */
export function claudeAskAnswerKeys(
  questions: HarnessAskQuestion[],
  answers: PromptAnswer[],
): Uint8Array[] {
  if (questions.length === 0) bad('no questions')
  for (const q of questions) {
    if (q.options.length > MAX_DIGIT_OPTIONS) {
      bad(`more than ${String(MAX_DIGIT_OPTIONS)} options`)
    }
  }
  const byQ = new Map<number, PromptAnswer>()
  for (const a of answers) {
    if (!Number.isInteger(a.question) || a.question < 0 || a.question >= questions.length) {
      bad(`unknown question index ${String(a.question)}`)
    }
    byQ.set(a.question, a)
  }

  const chunks: Uint8Array[] = []
  const onlyOne = questions.length === 1

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const ans = byQ.get(i)
    if (!ans) bad(`missing answer for question ${String(i)}`)
    const other = typeof ans.other === 'string'
    if (!other && ans.labels.length === 0) bad(`question ${String(i)} has no labels`)

    if (q.multiSelect) {
      for (const label of ans.labels) chunks.push(enc(optionDigit(questions, i, label)))
      if (other) {
        chunks.push(enc(otherDigit(q, i)))
        chunks.push(enc(ans.other!))
        chunks.push(enc('\r'))
      }
      // Digit toggles do not auto-advance; Tab moves to the next tab / Submit.
      // A single-question screen has no Tab row.
      if (!onlyOne) chunks.push(enc('\t'))
    } else if (other) {
      chunks.push(enc(otherDigit(q, i)))
      chunks.push(enc(ans.other!))
      chunks.push(enc('\r'))
      // Single-select Other: Enter submits the field. With one question that
      // also submits the prompt (no Submit tab). With several, Enter advances.
    } else {
      if (ans.labels.length !== 1) {
        bad(`question ${String(i)} single-select needs exactly one label`)
      }
      chunks.push(enc(optionDigit(questions, i, ans.labels[0])))
      // Digit selects AND auto-advances. No Tab.
    }
  }

  // Submit tab: present when there is more than one question. One-question
  // digit pick submits immediately; one-question Other submits on Enter.
  if (!onlyOne) chunks.push(enc('1'))
  return chunks
}

export function claudeApprovalKeys(decision: ApprovalDecision): Uint8Array[] {
  // 1 = allow once, 2 = allow + remember, 3 = deny. Esc is cancel (out of band).
  if (decision === 'allow') return [enc('1')]
  if (decision === 'allow-session') return [enc('2')]
  if (decision === 'deny') return [enc('3')]
  bad(`unsupported approval decision: ${decision}`)
}

export function grokApprovalKeys(decision: ApprovalDecision): Uint8Array[] {
  // grok 1.0.13 ┃ dialog (proven 09-04): 1 = Yes and don't ask again,
  // 2 = Yes proceed, 3 = No reject, 4 = Never allow (unused).
  if (decision === 'allow-session') return [enc('1')]
  if (decision === 'allow') return [enc('2')]
  if (decision === 'deny') return [enc('3')]
  bad(`unsupported approval decision: ${decision}`)
}

/**
 * kimi-code 0.36.0 approval panel — key mapping unverified. Treat as
 * `1`=allow, `2`=allow-session, `3`=deny (digits/Enter). Capture log only
 * showed the bottom of the panel (`3. Reject` / `4. Reject with feedback`).
 */
export function kimiApprovalKeys(decision: ApprovalDecision): Uint8Array[] {
  return claudeApprovalKeys(decision)
}
