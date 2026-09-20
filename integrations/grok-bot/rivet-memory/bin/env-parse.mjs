// Capture-side KEY=VALUE parse. Same rules as packages/cli parseRivetEnv /
// unquoteEnvValue: export prefix, quotes, last-wins, \$ is a literal $.
// Does not expand $HOME and does not run $( ) or backticks.

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isUnsetVal(val) {
  return val == null || val === '' || /^\$\{[A-Z0-9_]+\}$/.test(val)
}

export function parseRivetEnv(contents) {
  const text = String(contents).replace(/^\uFEFF/, '')
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(raw)
    if (!parsed) continue
    out[parsed.key] = parsed.value
  }
  return out
}

function parseEnvLine(raw) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) return undefined
  const rest = line.startsWith('export') && /^\s/.test(line.slice(6)) ? line.slice(6).trim() : line
  const eq = rest.indexOf('=')
  if (eq <= 0) return undefined
  const key = rest.slice(0, eq).trim()
  if (!KEY.test(key)) return undefined
  return { key, value: unquoteEnvValue(rest.slice(eq + 1)) }
}

function unquoteEnvValue(raw) {
  const s = raw.trim()
  if (s.startsWith('#')) return ''
  if (s.startsWith('"')) return decodeDoubleQuoted(s)
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1)
    return end === -1 ? s.slice(1) : s.slice(1, end)
  }
  return s.replace(/\s+#.*$/, '').trim()
}

function decodeDoubleQuoted(s) {
  let out = ''
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (c === '"') break
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1]
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'r') out += '\r'
      else out += n
      i++
      continue
    }
    out += c
  }
  return out
}
