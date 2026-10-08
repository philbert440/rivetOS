/**
 * One key combination, as stored for a rebindable shortcut. Pure: no DOM, no
 * store, so the matchers, the Settings recorder and tests all share it.
 *
 * A combo with a `code` matches the physical key (layout-stable — what Ctrl
 * chords use). Without one it matches `key`: letters ignore case (Caps Lock),
 * and a punctuation key ignores Shift, since Shift is how `?` is typed.
 */

export interface KeyCombo {
  /** `KeyboardEvent.key`; letters stored lower-case. */
  key: string
  /** `KeyboardEvent.code` when the combo is matched by physical key. */
  code?: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export type KeyFields = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'
>

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

function isLetter(key: string): boolean {
  return key.length === 1 && key.toLowerCase() !== key.toUpperCase()
}

/** A single printable symbol that is not a letter or digit, e.g. `?` `/` `` ` ``. */
function isPunctuation(key: string): boolean {
  return key.length === 1 && !isLetter(key) && !/[0-9 ]/.test(key)
}

export function combo(key: string, mods: Partial<Omit<KeyCombo, 'key'>> = {}): KeyCombo {
  return {
    key: isLetter(key) ? key.toLowerCase() : key,
    ...(mods.code ? { code: mods.code } : {}),
    ctrl: mods.ctrl ?? false,
    shift: mods.shift ?? false,
    alt: mods.alt ?? false,
    meta: mods.meta ?? false,
  }
}

export function hasCommandModifier(c: KeyCombo): boolean {
  return c.ctrl || c.alt || c.meta
}

export function matchCombo(c: KeyCombo, e: KeyFields): boolean {
  if (c.ctrl !== e.ctrlKey || c.alt !== e.altKey || c.meta !== e.metaKey) return false
  if (c.code) return e.code === c.code && c.shift === e.shiftKey
  if (isPunctuation(c.key)) return e.key === c.key
  if (c.shift !== e.shiftKey) return false
  return isLetter(c.key) ? e.key.toLowerCase() === c.key : e.key === c.key
}

/**
 * The combo a keypress records, or null for a bare modifier. With Ctrl, Alt
 * or Super held the physical key is kept (`code`), like the built-in chords.
 */
export function comboFromEvent(e: KeyFields): KeyCombo | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const mods = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey }
  if (hasCommandModifier(combo('', mods)) && e.code) {
    return combo(keyFromCode(e.code) ?? e.key, { ...mods, code: e.code })
  }
  return combo(e.key, mods)
}

/** The unshifted key a `code` names, when it is unambiguous. */
function keyFromCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const named: Record<string, string> = {
    Space: ' ',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
  }
  return named[code]
}

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
}

function keyName(c: KeyCombo): string {
  const key = c.code ? (keyFromCode(c.code) ?? c.code) : c.key
  if (KEY_NAMES[key]) return KEY_NAMES[key]
  return isLetter(key) ? key.toUpperCase() : key
}

/** `Ctrl+Shift+E`, `H`, `?`, `Ctrl+Space`. Two combos are the same shortcut
 *  exactly when their labels are equal. */
export function formatCombo(c: KeyCombo): string {
  const parts: string[] = []
  if (c.ctrl) parts.push('Ctrl')
  if (c.alt) parts.push('Alt')
  const name = keyName(c)
  if (c.shift && !(isPunctuation(name) && !c.code)) parts.push('Shift')
  if (c.meta) parts.push('Super')
  parts.push(name)
  return parts.join('+')
}

export function sameCombo(a: KeyCombo, b: KeyCombo): boolean {
  return formatCombo(a) === formatCombo(b)
}

/** Keep only well-formed combos from persisted data. */
export function normalizeCombos(raw: unknown): KeyCombo[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: KeyCombo[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.key !== 'string') continue
    const code = typeof r.code === 'string' && r.code ? r.code : undefined
    if (!r.key && !code) continue
    out.push(
      combo(r.key, {
        code,
        ctrl: r.ctrl === true,
        shift: r.shift === true,
        alt: r.alt === true,
        meta: r.meta === true,
      }),
    )
  }
  return out
}
