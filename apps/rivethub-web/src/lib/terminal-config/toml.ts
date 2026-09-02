/**
 * A minimal TOML reader for Alacritty configs — hand-written on purpose: the
 * importer must not add a runtime dependency to the hub bundle for one config
 * format, and Alacritty only ever uses the simple subset (tables, dotted
 * keys, strings, numbers, booleans, arrays, inline tables).
 *
 * Deliberately NOT supported, because Alacritty never emits them and a
 * half-right implementation is worse than a clean failure: multi-line basic
 * strings, dates/times (kept as strings), and integer bases other than 10.
 * Anything unparseable throws, and the caller downgrades that to a warning.
 */

import { isUnsafeKey, MAX_PARSER_CHARS, stripBom } from './common.js'

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable
export interface TomlTable {
  // `| undefined` on the index signature so a miss reads as undefined rather
  // than a lie the narrowing then optimises away — the walkers below branch
  // on exactly that.
  [key: string]: TomlValue | undefined
}

function newTable(): TomlTable {
  return Object.create(null) as TomlTable
}

class Cursor {
  constructor(
    readonly s: string,
    public i = 0,
    readonly warnings: string[] = [],
  ) {}
  get done(): boolean {
    return this.i >= this.s.length
  }
  peek(): string {
    return this.s[this.i] ?? ''
  }
  /** Whitespace, newlines and `#` comments — everything between tokens. */
  skipTrivia(stopAtNewline = false): void {
    for (;;) {
      const c = this.peek()
      if (c === '#') {
        while (!this.done && this.peek() !== '\n') this.i++
        continue
      }
      if (c === '\n' && stopAtNewline) return
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.i++
        continue
      }
      return
    }
  }
  fail(msg: string): never {
    throw new Error(`TOML: ${msg} at offset ${this.i}`)
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/

function readString(c: Cursor): string {
  const quote = c.peek()
  c.i++
  let out = ''
  while (!c.done) {
    const ch = c.s[c.i]
    if (ch === quote) {
      c.i++
      return out
    }
    // Literal strings ('…') take no escapes — that's the whole point of them.
    if (ch === '\\' && quote === '"') {
      c.i++
      if (c.done) c.fail('unterminated string')
      const esc = c.s[c.i]
      if (esc === 'u' || esc === 'U') {
        c.i++
        const len = esc === 'u' ? 4 : 8
        const hex = c.s.slice(c.i, c.i + len)
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) c.fail('invalid unicode escape')
        const code = parseInt(hex, 16)
        // Surrogates and values past U+10FFFF throw from fromCodePoint.
        if (
          !Number.isInteger(code) ||
          code < 0 ||
          code > 0x10ffff ||
          (code >= 0xd800 && code <= 0xdfff)
        ) {
          c.fail('invalid unicode escape')
        }
        out += String.fromCodePoint(code)
        c.i += len
        continue
      }
      const simple: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        '"': '"',
        '\\': '\\',
        b: '\b',
        f: '\f',
      }
      if (simple[esc] === undefined) c.fail(`unknown escape \\${esc}`)
      out += simple[esc]
      c.i++
      continue
    }
    if (ch === '\n') c.fail('unterminated string')
    out += ch
    c.i++
  }
  c.fail('unterminated string')
}

function readKeyPart(c: Cursor): string {
  const ch = c.peek()
  if (ch === '"' || ch === "'") return readString(c)
  let out = ''
  while (!c.done && BARE_KEY.test(c.peek())) {
    out += c.peek()
    c.i++
  }
  if (!out) c.fail('expected a key')
  return out
}

/** Dotted key path: `a.b."c d"`. */
function readKeyPath(c: Cursor): string[] {
  const parts = [readKeyPart(c)]
  for (;;) {
    c.skipTrivia(true)
    if (c.peek() !== '.') return parts
    c.i++
    c.skipTrivia(true)
    parts.push(readKeyPart(c))
  }
}

function readScalar(c: Cursor): TomlValue {
  let raw = ''
  while (!c.done && !',]}#\n'.includes(c.peek())) {
    raw += c.peek()
    c.i++
  }
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === '') c.fail('expected a value')
  const n = Number(v.replace(/_/g, ''))
  return Number.isFinite(n) ? n : v
}

function readValue(c: Cursor, depth = 0): TomlValue {
  if (depth > 32) c.fail('nested too deeply')
  c.skipTrivia(true)
  const ch = c.peek()
  if (ch === '"' || ch === "'") return readString(c)
  if (ch === '[') {
    c.i++
    const arr: TomlValue[] = []
    for (;;) {
      c.skipTrivia()
      if (c.peek() === ']') {
        c.i++
        return arr
      }
      if (c.done) c.fail('unterminated array')
      arr.push(readValue(c, depth + 1))
      c.skipTrivia()
      if (c.peek() === ',') c.i++
    }
  }
  if (ch === '{') {
    c.i++
    const table: TomlTable = newTable()
    for (;;) {
      c.skipTrivia()
      if (c.peek() === '}') {
        c.i++
        return table
      }
      if (c.done) c.fail('unterminated inline table')
      const path = readKeyPath(c)
      c.skipTrivia(true)
      if (c.peek() !== '=') c.fail('expected `=` in inline table')
      c.i++
      assign(table, path, readValue(c, depth + 1), c)
      c.skipTrivia()
      if (c.peek() === ',') c.i++
    }
  }
  return readScalar(c)
}

function ignoreUnsafe(c: Cursor, key: string, path: string[]): boolean {
  if (!isUnsafeKey(key)) return false
  c.warnings.push(`Ignoring unsafe key \`${[...path, key].join('.')}\`.`)
  return true
}

/** Walk/create the nested tables for `path` and set the leaf. */
function assign(root: TomlTable, path: string[], value: TomlValue, c: Cursor): void {
  let node = root
  const parents = path.slice(0, -1)
  for (let i = 0; i < parents.length; i++) {
    const part = parents[i]
    if (ignoreUnsafe(c, part, parents.slice(0, i))) return
    const next = Object.hasOwn(node, part) ? node[part] : undefined
    if (next === undefined) {
      const created = newTable()
      node[part] = created
      node = created
    } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      node = next
    } else {
      c.fail(`\`${path.join('.')}\` redefines a non-table`)
    }
  }
  const leaf = path[path.length - 1]
  if (ignoreUnsafe(c, leaf, parents)) return
  if (Object.hasOwn(node, leaf)) c.fail(`duplicate key \`${path.join('.')}\``)
  node[leaf] = value
}

/** Resolve (creating as needed) the table a `[header]` names. */
function tableAt(root: TomlTable, path: string[], arrayOfTables: boolean, c: Cursor): TomlTable {
  let node = root
  const parents = path.slice(0, -1)
  for (let i = 0; i < parents.length; i++) {
    const part = parents[i]
    if (ignoreUnsafe(c, part, parents.slice(0, i))) return newTable()
    let next = Object.hasOwn(node, part) ? node[part] : undefined
    if (Array.isArray(next)) next = next[next.length - 1]
    if (next === undefined) {
      const created = newTable()
      node[part] = created
      node = created
    } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      node = next
    } else {
      c.fail(`\`${path.join('.')}\` redefines a non-table`)
    }
  }
  const leaf = path[path.length - 1]
  if (ignoreUnsafe(c, leaf, parents)) return newTable()
  const existing = Object.hasOwn(node, leaf) ? node[leaf] : undefined
  if (arrayOfTables) {
    if (existing !== undefined && !Array.isArray(existing)) {
      c.fail(`\`[[${path.join('.')}]]\` over an existing table`)
    }
    const arr = Array.isArray(existing) ? existing : []
    const created = newTable()
    arr.push(created)
    node[leaf] = arr
    return created
  }
  if (Array.isArray(existing)) {
    c.fail(`\`[${path.join('.')}]\` redefines an array of tables`)
  }
  if (existing !== undefined && typeof existing === 'object' && existing !== null) {
    return existing
  }
  const created = newTable()
  node[leaf] = created
  return created
}

export function parseToml(text: string, warnings: string[] = []): TomlTable {
  text = stripBom(text)
  if (text.length > MAX_PARSER_CHARS) throw new Error('TOML: input larger than 1 MB')
  const root = newTable()
  const c = new Cursor(text, 0, warnings)
  let current = root
  for (;;) {
    c.skipTrivia()
    if (c.done) return root
    if (c.peek() === '[') {
      c.i++
      const arrayOfTables = c.peek() === '['
      if (arrayOfTables) c.i++
      c.skipTrivia(true)
      const path = readKeyPath(c)
      c.skipTrivia(true)
      if (c.peek() !== ']') c.fail('expected `]`')
      c.i++
      if (arrayOfTables) {
        if (c.peek() !== ']') c.fail('expected `]]`')
        c.i++
      }
      current = tableAt(root, path, arrayOfTables, c)
      continue
    }
    const path = readKeyPath(c)
    c.skipTrivia(true)
    if (c.peek() !== '=') c.fail('expected `=`')
    c.i++
    assign(current, path, readValue(c), c)
  }
}
