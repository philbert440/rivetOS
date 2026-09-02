/**
 * Read-only importer for the user's installed terminal-emulator configs
 * (T4). Main hands the renderer BYTES; every format decision lives in
 * rivethub-web's `lib/terminal-config` parsers, so this module only has to be
 * careful about which files it is willing to open.
 *
 * Two rules make that safe:
 *  - only the per-emulator candidate paths below are ever opened, and only the
 *    first one that exists per emulator;
 *  - `include` / `config-file` / `import` directives are followed exactly ONE
 *    level and only to files that resolve — after realpath, so a symlink can't
 *    launder the check — inside an allowed include root (see includeRoots: the
 *    config's own directory, EXCEPT when that directory is a shared one like
 *    $HOME, where the emulator's own config directory is used instead).
 *
 * Nothing here writes, creates, or deletes anything.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type EmulatorKind = 'ghostty' | 'alacritty' | 'kitty' | 'windows-terminal'

export interface TerminalConfigFile {
  kind: EmulatorKind
  path: string
  text: string
  /** Resolved include contents, keyed by the raw directive value so the
   *  renderer's parser can splice each one where it appeared. */
  includes: Record<string, string>
}

/** Per file, main config and includes alike. A terminal config is a few KB;
 *  anything at this size is not one, and we will not buffer it. */
export const MAX_CONFIG_BYTES = 256 * 1024

/** Includes followed per config — a theme plus a machine-local override is
 *  the realistic shape; more than this is a loop or a generated file. */
const MAX_INCLUDES = 8

export interface ConfigEnv {
  home: string
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
}

function defaultEnv(): ConfigEnv {
  return { home: os.homedir(), platform: process.platform, env: process.env }
}

/**
 * Where each emulator keeps its config, in priority order. The allowlist IS
 * the security boundary for the top-level read: nothing outside this list is
 * ever opened, whatever the renderer asks for (it can't ask — the channel
 * takes no arguments).
 */
const ALACRITTY_NAMES = ['alacritty.toml', 'alacritty.yml', 'alacritty.yaml'] as const

export function candidatePaths(e: ConfigEnv): Array<{ kind: EmulatorKind; path: string }> {
  const out: Array<{ kind: EmulatorKind; path: string }> = []
  const add = (kind: EmulatorKind, ...parts: Array<string | undefined>): void => {
    if (parts.some((p) => !p)) return
    out.push({ kind, path: path.join(...(parts as string[])) })
  }
  const xdg = e.env.XDG_CONFIG_HOME
  const home = e.home
  const dotConfig = path.join(home, '.config')

  add('ghostty', xdg, 'ghostty', 'config')
  add('ghostty', dotConfig, 'ghostty', 'config')
  if (e.platform === 'darwin') {
    add('ghostty', home, 'Library', 'Application Support', 'com.mitchellh.ghostty', 'config')
  }

  // Alacritty's documented search order, TOML before the legacy YAML at each
  // step: <cfg>/alacritty/alacritty.*, <cfg>/alacritty.*, then $HOME/.alacritty.*
  for (const base of [xdg, dotConfig]) {
    for (const name of ALACRITTY_NAMES) add('alacritty', base, 'alacritty', name)
    for (const name of ALACRITTY_NAMES) add('alacritty', base, name)
  }
  for (const name of ALACRITTY_NAMES) add('alacritty', home, `.${name}`)
  if (e.platform === 'win32') {
    for (const name of ALACRITTY_NAMES) add('alacritty', e.env.APPDATA, 'alacritty', name)
  }

  add('kitty', xdg, 'kitty', 'kitty.conf')
  add('kitty', dotConfig, 'kitty', 'kitty.conf')
  if (e.platform === 'darwin') add('kitty', home, 'Library', 'Preferences', 'kitty', 'kitty.conf')

  if (e.platform === 'win32') {
    const local = e.env.LOCALAPPDATA
    add(
      'windows-terminal',
      local,
      'Packages',
      'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    )
    add(
      'windows-terminal',
      local,
      'Packages',
      'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe',
      'LocalState',
      'settings.json',
    )
    // Unpackaged (scoop/choco/portable) install.
    add('windows-terminal', local, 'Microsoft', 'Windows Terminal', 'settings.json')
  }
  return out
}

export interface IncludeOpts {
  /** Home directory, for `~`-spelled targets. Without it, `~` is refused. */
  home?: string
  /** Defaults to the running platform; only win32 changes the rules. */
  platform?: NodeJS.Platform
}

/**
 * An include target resolved inside `dir`, or null.
 *
 * Containment is the whole property, so the check is expressed as "resolves
 * under dir" rather than "looks relative": `~/.config/alacritty/themes/x.toml`
 * is how people actually spell an Alacritty import, and refusing it outright
 * would make the importer useless while making nothing safer. `..`, an
 * absolute path elsewhere, and a NUL are all refused. A backslash is refused
 * everywhere but win32, where it is a real separator node's path module
 * already understands; on POSIX it would survive resolve() as a literal
 * filename character and confuse the fence's mental model (same reasoning as
 * den-server's resolveFenced).
 */
export function resolveIncludePath(
  dir: string,
  rel: string,
  opts: IncludeOpts = {},
): string | null {
  const platform = opts.platform ?? process.platform
  if (!rel || rel.includes('\0')) return null
  if (rel.includes('\\') && platform !== 'win32') return null
  let target = rel.trim()
  if (target.startsWith('~/') || target === '~') {
    if (!opts.home) return null
    // path.join, not resolve: `~/x`.slice(1) is `/x`, which resolve() would
    // read as an absolute path and discard the home prefix.
    target = path.join(opts.home, target.slice(1))
  }
  const abs = path.resolve(dir, target)
  return abs === dir || abs.startsWith(dir + path.sep) ? abs : null
}

/** realpath both ends before comparing — a symlink is the one escape the
 *  lexical check above cannot see. */
function realWithin(root: string, abs: string): string | null {
  try {
    const realRoot = fs.realpathSync(root)
    const real = fs.realpathSync(abs)
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null
  } catch {
    return null
  }
}

/**
 * Read at most MAX_CONFIG_BYTES from an open descriptor, or null if the file
 * is bigger (or isn't a file at all).
 *
 * Deliberately open-then-fstat-then-read rather than stat-then-readFileSync:
 * with the two-call form a file that is replaced or grown between the size
 * check and the read gets fully buffered anyway. Here the cap is enforced by
 * the buffer itself — one byte over and the content is dropped.
 */
function readCapped(file: string): string | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, 'r')
    if (!fs.fstatSync(fd).isFile()) return null
    const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let total = 0
    for (;;) {
      const n = fs.readSync(fd, buf, total, buf.length - total, total)
      if (n === 0) break
      total += n
      if (total > MAX_CONFIG_BYTES) return null
    }
    return buf.subarray(0, total).toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already gone — nothing to release */
      }
    }
  }
}

/** Read a file that must live inside `dir`, honoring the size cap. */
export function readFenced(dir: string, rel: string, opts: IncludeOpts = {}): string | null {
  const abs = resolveIncludePath(dir, rel, opts)
  if (!abs) return null
  const real = realWithin(dir, abs)
  if (!real) return null
  return readCapped(real)
}

const QUOTED = /"([^"]*)"|'([^']*)'/g

/** Matching-pair unquote so `?"path"` keeps the quotes for the next step. */
function unquoteValue(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2) {
    const q = v[0]
    if ((q === '"' || q === "'") && v.endsWith(q)) return v.slice(1, -1)
  }
  return v
}

/**
 * The include targets a config names, as written. Deliberately a scanner
 * rather than a parse: main does not need to understand these formats, only
 * to know which neighbouring files the renderer's parser will ask about.
 */
export function includeTargets(kind: EmulatorKind, rawText: string): string[] {
  // `$` under /m does not consume the `\r` of a CRLF file, which would leave a
  // stray carriage return on the target and make every lookup miss.
  const text = rawText.replace(/\r\n?/g, '\n')
  const out: string[] = []
  const push = (v: string | undefined): void => {
    const t = v?.trim().replace(/^["']|["']$/g, '')
    if (t && !out.includes(t)) out.push(t)
  }
  if (kind === 'ghostty') {
    // Optional include is `config-file = ?path` — the `?` prefixes the VALUE,
    // not the key. Strip `?` before quotes so `?"path"` keys as `path`,
    // matching the renderer (`unquote`, then `?`, then `unquote` again).
    for (const m of text.matchAll(/^[ \t]*config-file[ \t]*=[ \t]*(.+)$/gm)) {
      let t = unquoteValue(m[1] ?? '')
      if (t.startsWith('?')) t = unquoteValue(t.slice(1))
      if (t && !out.includes(t)) out.push(t)
    }
  } else if (kind === 'kitty') {
    for (const m of text.matchAll(/^[ \t]*include[ \t]+(.+)$/gm)) push(m[1])
  } else if (kind === 'alacritty') {
    // TOML: `import = [ "a.toml", … ]`, possibly across lines, at the root or
    // under [general].
    for (const m of text.matchAll(/^[ \t]*import[ \t]*=[ \t]*\[([\s\S]*?)\]/gm)) {
      for (const q of m[1].matchAll(QUOTED)) push(q[1] ?? q[2])
    }
    // Legacy YAML: an `import:` key followed by a `- path` list.
    if (/^[ \t]*import[ \t]*:/m.test(text)) {
      for (const m of text.matchAll(/^[ \t]*-[ \t]*(.+\.(?:toml|ya?ml))[ \t]*$/gm)) push(m[1])
    }
  }
  return out.slice(0, MAX_INCLUDES)
}

/** Each emulator's own directory under a config root. Windows Terminal has no
 *  include mechanism, so it never needs one. */
const KIND_DIR: Record<EmulatorKind, string | undefined> = {
  ghostty: 'ghostty',
  alacritty: 'alacritty',
  kitty: 'kitty',
  'windows-terminal': undefined,
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** A primary candidate may be a symlink (dotfiles repos), but the real
 *  file's basename must still look like THAT emulator's config so
 *  `ghostty/config → ~/.ssh/config` is not handed to the renderer. Ghostty's
 *  file is literally named `config`, so the parent directory must be the
 *  emulator's own (`ghostty` / `com.mitchellh.ghostty`). */
function looksLikeConfigBasename(kind: EmulatorKind, file: string): boolean {
  const base = path.basename(file)
  const parent = path.basename(path.dirname(file))
  switch (kind) {
    case 'ghostty':
      return base === 'config' && (parent === 'ghostty' || parent === 'com.mitchellh.ghostty')
    case 'kitty':
      return base === 'kitty.conf'
    case 'alacritty':
      return /^(?:\.?alacritty)\.(toml|ya?ml)$/i.test(base)
    case 'windows-terminal':
      return /^settings\.json$/i.test(base)
  }
}

/**
 * The directories an include may resolve inside.
 *
 * Normally that is simply the config file's own directory. The exception is
 * what makes this function exist: `~/.alacritty.toml` — and any dotfiles
 * symlink whose real file sits directly in $HOME or in a config ROOT — would
 * otherwise fence includes to that whole shared directory, turning
 * `import = [".ssh/id_rsa"]` into a read that main hands to the renderer. When
 * the config lives in a shared directory, includes are fenced to the
 * emulator's own config directory instead, which is where a theme file
 * actually lives.
 */
export function includeRoots(kind: EmulatorKind, e: ConfigEnv, configDir: string): string[] {
  const dirName = KIND_DIR[kind]
  if (!dirName) return []
  const real = realOrSelf(configDir)
  const shared = [e.home, path.join(e.home, '.config'), e.env.XDG_CONFIG_HOME]
  if (e.platform === 'darwin') {
    shared.push(
      path.join(e.home, 'Library', 'Application Support'),
      path.join(e.home, 'Library', 'Preferences'),
    )
  }
  if (!shared.some((d) => d && realOrSelf(d) === real)) return [configDir]

  const own: Array<string | undefined> = [
    e.env.XDG_CONFIG_HOME ? path.join(e.env.XDG_CONFIG_HOME, dirName) : undefined,
    path.join(e.home, '.config', dirName),
  ]
  if (e.platform === 'darwin') {
    if (kind === 'ghostty') {
      own.push(path.join(e.home, 'Library', 'Application Support', 'com.mitchellh.ghostty'))
    }
    if (kind === 'kitty') own.push(path.join(e.home, 'Library', 'Preferences', 'kitty'))
  }
  if (e.platform === 'win32' && e.env.APPDATA) own.push(path.join(e.env.APPDATA, dirName))
  return own.filter((d): d is string => d !== undefined)
}

/**
 * Every emulator config we can find, first candidate per emulator. Missing or
 * unreadable files are simply absent — "not found" is a normal state the UI
 * renders, not an error.
 */
export function readTerminalConfigs(e: ConfigEnv = defaultEnv()): TerminalConfigFile[] {
  const out: TerminalConfigFile[] = []
  const seen = new Set<EmulatorKind>()
  for (const candidate of candidatePaths(e)) {
    if (seen.has(candidate.kind)) continue
    let real: string
    try {
      // Resolve the link first: a dotfiles-managed config is usually a
      // symlink, and its includes sit next to the REAL file.
      real = fs.realpathSync(candidate.path)
    } catch {
      continue
    }
    if (!looksLikeConfigBasename(candidate.kind, real)) continue
    const text = readCapped(real)
    if (text === null) continue
    seen.add(candidate.kind)
    const roots = includeRoots(candidate.kind, e, path.dirname(real))
    const includes: Record<string, string> = {}
    for (const target of includeTargets(candidate.kind, text)) {
      for (const root of roots) {
        const included = readFenced(root, target, { home: e.home, platform: e.platform })
        if (included !== null) {
          includes[target] = included
          break
        }
      }
    }
    // The path reported is the one from the allowlist, not the link target:
    // it is what the user recognises in the UI.
    out.push({ kind: candidate.kind, path: candidate.path, text, includes })
  }
  return out
}
