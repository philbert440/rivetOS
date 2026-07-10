/**
 * Claude spinner status lines — "✳ Wrangling… (28s · ↓ 4.8k tokens)" or
 * "✢ Architecting… (1m 22s · …)". The den hook only emits one when a hook
 * event fires, so between hooks the elapsed time freezes; parse the line so
 * the view can tick the seconds locally (den room.ts parity).
 */

export interface SpinnerMeta {
  /** everything through the opening paren, e.g. "✳ Wrangling… (" */
  pre: string
  /** parsed elapsed seconds at emit time */
  secs: number
  /** everything from the separator on, e.g. " · ↓ 4.8k tokens)" */
  suf: string
}

const SPINNER_RE = /^([✳✢✻✽·] .* \()(?:(\d+)m )?(\d+)s( · .*\))$/

export function parseSpinnerMeta(text: string): SpinnerMeta | null {
  const m = SPINNER_RE.exec(text)
  if (!m) return null
  return {
    pre: m[1],
    // the minutes group is optional (absent on sub-minute spinners) — it is
    // undefined at runtime despite the string type, so || covers both
    secs: Number(m[2] || 0) * 60 + Number(m[3]),
    suf: m[4],
  }
}

export function formatSpinnerMeta(meta: SpinnerMeta, extraSecs: number): string {
  const secs = meta.secs + Math.max(0, extraSecs)
  const dur =
    secs < 60 ? `${String(secs)}s` : `${String(Math.floor(secs / 60))}m ${String(secs % 60)}s`
  return `${meta.pre}${dur}${meta.suf}`
}
