/**
 * Hermes TUI paints a `┌─ Reasoning ──┐` box (and a quiet-mode prelude
 * without the │ body). That decoration is presentation, not the reply —
 * Rivet Bot / RivetHub must never show it as assistant text.
 *
 * Keep the copy in integrations/hermes/rivet-den/hooks/hermes-den-hook.mjs
 * and apps/rivet-bots-android HermesReasoning.kt in sync with this.
 */

export interface HermesSplit {
  reasoning: string
  text: string
}

/** CSI + OSC so a colour-wrapped box still matches. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
}

const HEADER = /^[\s]*[┌╭][─━\s]*\b(Reasoning|Thought|Thinking)\b/i
const FOOTER = /^[\s]*[└╰][─━\s]+[┘╯][\s]*$/
const BODY = /^[\s]*[│┃├┤]/

export function splitHermesReasoning(input: string): HermesSplit {
  if (!input) return { reasoning: '', text: '' }
  const lines = input.split(/\r?\n/)
  const reasoning: string[] = []
  const text: string[] = []
  let i = 0
  while (i < lines.length) {
    const vis = stripAnsi(lines[i])
    if (!HEADER.test(vis)) {
      text.push(lines[i])
      i += 1
      continue
    }
    i += 1
    let sawBox = false
    while (i < lines.length) {
      const v = stripAnsi(lines[i])
      if (FOOTER.test(v)) {
        i += 1
        break
      }
      if (BODY.test(v)) {
        sawBox = true
        reasoning.push(v.replace(/^[\s]*[│┃├┤]\s?/, ''))
        i += 1
        continue
      }
      if (sawBox) break
      if (!v.trim()) {
        i += 1
        break
      }
      reasoning.push(v)
      i += 1
    }
  }
  return { reasoning: reasoning.join('\n').trim(), text: text.join('\n').trim() }
}
