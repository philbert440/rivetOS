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
 *    launder the check — inside an allowed include root (see includeRoots for
 *    the relative-path base, and includeAllowRoots for the extra containment
 *    roots: the emulator's own config dir, $XDG_CONFIG_HOME / ~/.config,
 *    $XDG_STATE_HOME / ~/.local/state, and ~/.local/share). The $HOME-rooted
 *    carve-out still applies: a config sitting in $HOME does not make $HOME
 *    itself an include root.
 *
 * Nothing here writes, creates, or deletes anything.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type EmulatorKind = 'ghostty' | 'alacritty' | 'kitty' | 'windows-terminal' | 'omarchy'

export interface TerminalConfigFile {
  kind: EmulatorKind
  path: string
  text: string
  /** Resolved include contents, keyed by the raw directive value so the
   *  renderer's parser can splice each one where it appeared. */
  includes: Record<string, string>
  /** Basename of the Omarchy theme symlink target. Only set for `omarchy`.
   *  Omitted when the theme dir itself is named `theme` (a real directory
   *  at `current/theme`, not a symlink to `themes/<name>`). */
  themeName?: string
  /** True when an include's realpath sits under the Omarchy current-theme
   *  directory. The settings row uses this to pick the font partner for an
   *  Omarchy import (stale Ghostty must not beat the Alacritty that actually
   *  includes the theme). */
  usesOmarchy?: boolean
  /** Omarchy `colors.toml` text, schema A or B; only for kind `omarchy`. */
  colorsToml?: string
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
  const xdgState = e.env.XDG_STATE_HOME
  const home = e.home
  const dotConfig = path.join(home, '.config')
  const dotState = path.join(home, '.local', 'state')

  // Omarchy first so the settings row can show it ahead of the emulators.
  // current/theme is a directory (usually a symlink to themes/<name>).
  add('omarchy', xdgState, 'omarchy', 'current', 'theme')
  add('omarchy', dotState, 'omarchy', 'current', 'theme')
  add('omarchy', xdg, 'omarchy', 'current', 'theme')
  add('omarchy', dotConfig, 'omarchy', 'current', 'theme')

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
  /** Extra directories a target may resolve inside. Relative targets still
   *  resolve against `dir`; these roots only widen the containment check
   *  (lexical and realpath). Empty entries are ignored. */
  extraRoots?: readonly string[]
}

/**
 * An include target resolved inside `dir` (or an extra allowed root), or null.
 *
 * Containment is the whole property, so the check is expressed as "resolves
 * under dir or extraRoots" rather than "looks relative": Omarchy themes live
 * under `~/.local/state/omarchy/…` (and older `~/.config/omarchy/…`), which
 * is outside the emulator's own config directory. `~/.ssh`, `/etc`, and any
 * other landing outside the allowed roots are refused. A backslash is refused
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
  const roots = [dir, ...(opts.extraRoots ?? [])]
  return roots.some((root) => lexicallyWithin(root, abs)) ? abs : null
}

function lexicallyWithin(root: string, abs: string): boolean {
  if (!root) return false
  const r = path.resolve(root)
  return abs === r || abs.startsWith(r + path.sep)
}

/** realpath both ends before comparing — a symlink is the one escape the
 *  lexical check above cannot see. The target's realpath may land in any of
 *  `roots` (emulator dir, XDG config/state, ~/.local/share), so a
 *  `~/.local/state/omarchy/current/theme` → `~/.config/omarchy/themes/<name>`
 *  symlink still passes. Missing roots are skipped rather than failing the
 *  whole check. */
function realWithinAny(roots: readonly string[], abs: string): string | null {
  let real: string
  try {
    real = fs.realpathSync(abs)
  } catch {
    return null
  }
  for (const root of roots) {
    if (!root) continue
    try {
      const realRoot = fs.realpathSync(root)
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return real
    } catch {
      /* root missing — try the next one */
    }
  }
  return null
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

/** Read a file that must live inside `dir` (or extraRoots), honoring the size cap. */
export function readFenced(dir: string, rel: string, opts: IncludeOpts = {}): string | null {
  return readFencedEntry(dir, rel, opts)?.text ?? null
}

function readFencedEntry(
  dir: string,
  rel: string,
  opts: IncludeOpts = {},
): { text: string; real: string } | null {
  const abs = resolveIncludePath(dir, rel, opts)
  if (!abs) return null
  const real = realWithinAny([dir, ...(opts.extraRoots ?? [])], abs)
  if (!real) return null
  const text = readCapped(real)
  if (text === null) return null
  return { text, real }
}

/** Realpaths of Omarchy `current/theme` directories that exist. An include
 *  whose realpath sits under one of these is the emulator actually in use. */
function realOmarchyThemeDirs(e: ConfigEnv): string[] {
  const out: string[] = []
  for (const c of candidatePaths(e)) {
    if (c.kind !== 'omarchy') continue
    try {
      const real = fs.realpathSync(c.path)
      if (!fs.statSync(real).isDirectory()) continue
      if (!out.includes(real)) out.push(real)
    } catch {
      /* missing — try the next candidate */
    }
  }
  return out
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
  omarchy: undefined,
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
    case 'omarchy':
      return false
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
 * Extra containment roots for includes (and for the Omarchy theme dir).
 *
 * Both the XDG override and the default are listed: an older Omarchy install
 * still lives under ~/.config even when XDG_CONFIG_HOME points elsewhere, and
 * a theme symlink may jump from state → config. $HOME itself is never a root
 * — nor is a relative XDG value, the filesystem root, or any ancestor of
 * $HOME (`XDG_STATE_HOME=/` or `=$HOME` would otherwise reopen ~/.ssh).
 */
export function includeAllowRoots(e: ConfigEnv): string[] {
  const out: string[] = []
  const home = path.resolve(e.home)
  const add = (p: string | undefined): void => {
    if (!p || !path.isAbsolute(p)) return
    const abs = path.resolve(p)
    // `/` (or `C:\`) as a containment root is every path on the volume.
    if (abs === path.parse(abs).root) return
    // Skip a root that *is* $HOME or contains it (an ancestor). Legit
    // roots sit outside $HOME (`/run/user/1000/…`) or strictly under it
    // (`~/.local/state`); those do not satisfy lexicallyWithin(root, home).
    if (lexicallyWithin(abs, home)) return
    if (!out.includes(abs)) out.push(abs)
  }
  add(e.env.XDG_CONFIG_HOME)
  add(path.join(e.home, '.config'))
  add(e.env.XDG_STATE_HOME)
  add(path.join(e.home, '.local', 'state'))
  add(e.env.XDG_DATA_HOME)
  add(path.join(e.home, '.local', 'share'))
  return out
}

const OMARCHY_THEME_FILES = ['ghostty.conf', 'alacritty.toml', 'kitty.conf'] as const
const OMARCHY_THEME_NAME_RE = /^[A-Za-z0-9._-]+$/

/** Sibling `current/theme.name` (Omarchy 4.x real `theme` dir). Contained
 *  the same way as the theme files; rejected if it is not a short identifier. */
function readOmarchyThemeNameFile(realDir: string, allow: readonly string[]): string | undefined {
  const abs = path.join(path.dirname(realDir), 'theme.name')
  const real = realWithinAny(allow, abs)
  if (!real) return undefined
  const text = readCapped(real)
  if (text === null) return undefined
  const name = text.trim()
  if (name.length === 0 || name.length > 64 || !OMARCHY_THEME_NAME_RE.test(name)) return undefined
  return name
}

function readOmarchyColorsToml(realDir: string, allow: readonly string[]): string | undefined {
  const abs = path.join(realDir, 'colors.toml')
  const real = realWithinAny(allow, abs)
  if (!real) return undefined
  const text = readCapped(real)
  return text === null ? undefined : text
}

/** Read the Omarchy current-theme directory: ghostty.conf preferred, then
 *  alacritty.toml, then kitty.conf. Also reads `colors.toml` (app theme) and,
 *  when the dir is a real `theme` directory, sibling `theme.name`. The theme
 *  dir's realpath must sit under includeAllowRoots so `current/theme → ~/.ssh`
 *  is not a read. A dir with only `colors.toml` still yields an entry. */
function readOmarchyTheme(themeDir: string, e: ConfigEnv): TerminalConfigFile | null {
  const allow = includeAllowRoots(e)
  const realDir = realWithinAny(allow, themeDir)
  if (!realDir) return null
  try {
    if (!fs.statSync(realDir).isDirectory()) return null
  } catch {
    return null
  }
  const base = path.basename(realDir)
  let themeName = base === 'theme' ? undefined : base
  if (!themeName) themeName = readOmarchyThemeNameFile(realDir, allow)
  const colorsToml = readOmarchyColorsToml(realDir, allow)
  const extra = {
    ...(colorsToml !== undefined ? { colorsToml } : {}),
    ...(themeName ? { themeName } : {}),
  }
  for (const name of OMARCHY_THEME_FILES) {
    const abs = path.join(realDir, name)
    const realFile = realWithinAny(allow, abs)
    // Containment is the safety property; a theme file may be a symlink
    // whose target has a different basename (`ghostty.conf` → `colors.conf`).
    if (!realFile) continue
    const text = readCapped(realFile)
    if (text === null) continue
    return {
      kind: 'omarchy',
      path: path.join(themeDir, name),
      text,
      includes: {},
      ...extra,
    }
  }
  if (colorsToml !== undefined) {
    return {
      kind: 'omarchy',
      path: path.join(themeDir, 'colors.toml'),
      text: '',
      includes: {},
      ...extra,
    }
  }
  return null
}

/**
 * Every emulator config we can find, first candidate per emulator. Missing or
 * unreadable files are simply absent — "not found" is a normal state the UI
 * renders, not an error.
 */
export function readTerminalConfigs(e: ConfigEnv = defaultEnv()): TerminalConfigFile[] {
  const out: TerminalConfigFile[] = []
  const seen = new Set<EmulatorKind>()
  const extraRoots = includeAllowRoots(e)
  const omarchyThemeDirs = realOmarchyThemeDirs(e)
  for (const candidate of candidatePaths(e)) {
    if (seen.has(candidate.kind)) continue
    if (candidate.kind === 'omarchy') {
      const file = readOmarchyTheme(candidate.path, e)
      if (file) {
        seen.add('omarchy')
        out.push(file)
      }
      continue
    }
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
    let usesOmarchy = false
    for (const target of includeTargets(candidate.kind, text)) {
      for (const root of roots) {
        const included = readFencedEntry(root, target, {
          home: e.home,
          platform: e.platform,
          extraRoots,
        })
        if (included !== null) {
          includes[target] = included.text
          if (omarchyThemeDirs.some((dir) => lexicallyWithin(dir, included.real))) {
            usesOmarchy = true
          }
          break
        }
      }
    }
    // The path reported is the one from the allowlist, not the link target:
    // it is what the user recognises in the UI.
    out.push({
      kind: candidate.kind,
      path: candidate.path,
      text,
      includes,
      ...(usesOmarchy ? { usesOmarchy } : {}),
    })
  }
  return out
}
