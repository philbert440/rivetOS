/**
 * Filter OSC color sequences that otherwise leak into the harness PTY as
 * fake keystrokes (visible as `]11;rgb:0d0d/1111/1717` — theme bg #0d1117).
 *
 * See xterm-attach.tsx for the full story.
 */

// ESC, BEL — intentional control chars for OSC matching.
/* eslint-disable no-control-regex */

const OSC_COLOR_QUERY = /\u001b\](?:10|11|12);\?(?:\u0007|\u001b\\)/g
const OSC_COLOR_REPORT = /(?:\u001b)?\](?:10|11|12);rgb:/i

/**
 * Strip OSC 10/11/12 color *queries* from PTY→xterm bytes so attach/scrollback
 * replay does not generate rgb: replies via onData.
 */
export function stripOscColorQueries(data: Uint8Array): Uint8Array {
  let s = ''
  for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i] ?? 0)
  const cleaned = s.replace(OSC_COLOR_QUERY, '')
  if (cleaned.length === s.length) return data
  const out = new Uint8Array(cleaned.length)
  for (let i = 0; i < cleaned.length; i++) out[i] = cleaned.charCodeAt(i) & 0xff
  return out
}

/** True if data looks like an xterm-generated OSC color report (fg/bg/cursor). */
export function isOscColorReport(data: string): boolean {
  return OSC_COLOR_REPORT.test(data)
}
