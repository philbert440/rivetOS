import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  candidatePaths,
  includeRoots,
  includeTargets,
  MAX_CONFIG_BYTES,
  readFenced,
  readTerminalConfigs,
  resolveIncludePath,
  type ConfigEnv,
} from './terminal-config.js'

let home: string
let outside: string
const env = (over: Partial<ConfigEnv> = {}): ConfigEnv => ({
  home,
  platform: 'linux',
  env: {},
  ...over,
})

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-home-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-out-'))
})
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

describe('candidatePaths', () => {
  it('prefers XDG_CONFIG_HOME and only lists this platform', () => {
    const linux = candidatePaths(env({ env: { XDG_CONFIG_HOME: '/xdg' } }))
    expect(linux[0]).toEqual({ kind: 'ghostty', path: '/xdg/ghostty/config' })
    expect(linux.some((c) => c.path === path.join(home, '.config/ghostty/config'))).toBe(true)
    expect(linux.some((c) => c.kind === 'windows-terminal')).toBe(false)
    expect(linux.some((c) => c.path.includes('Application Support'))).toBe(false)
  })

  it('lists the Windows Terminal packages only on win32', () => {
    const win = candidatePaths(
      env({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\lad', APPDATA: 'C:\\ad' } }),
    )
    const wt = win.filter((c) => c.kind === 'windows-terminal').map((c) => c.path)
    expect(wt).toHaveLength(3)
    expect(wt[0]).toContain('Microsoft.WindowsTerminal_8wekyb3d8bbwe')
    expect(wt[1]).toContain('WindowsTerminalPreview')
    expect(win.some((c) => c.kind === 'alacritty' && c.path.startsWith('C:\\ad'))).toBe(true)
  })

  it('covers every documented Alacritty location and spelling, TOML first', () => {
    const paths = candidatePaths(env({ env: { XDG_CONFIG_HOME: '/xdg' } }))
      .filter((c) => c.kind === 'alacritty')
      .map((c) => c.path)
    expect(paths).toContain('/xdg/alacritty/alacritty.toml')
    expect(paths).toContain('/xdg/alacritty.toml')
    expect(paths).toContain(path.join(home, '.config/alacritty/alacritty.toml'))
    expect(paths).toContain(path.join(home, '.config/alacritty.toml'))
    expect(paths).toContain(path.join(home, '.alacritty.toml'))
    expect(paths.some((p) => p.endsWith('alacritty.yaml'))).toBe(true)
    expect(paths.indexOf('/xdg/alacritty/alacritty.toml')).toBeLessThan(
      paths.indexOf('/xdg/alacritty/alacritty.yml'),
    )
  })

  it('skips candidates whose base directory the environment does not define', () => {
    // No XDG_CONFIG_HOME, no LOCALAPPDATA — nothing should be joined onto
    // undefined and produce a bogus relative path.
    for (const c of candidatePaths(env({ platform: 'win32' }))) {
      expect(path.isAbsolute(c.path) || /^[A-Za-z]:/.test(c.path)).toBe(true)
    }
  })

  it('yields no windows-terminal or APPDATA-alacritty candidates when those env vars are unset', () => {
    const win = candidatePaths(env({ platform: 'win32', env: {} }))
    expect(win.filter((c) => c.kind === 'windows-terminal')).toEqual([])
    expect(win.some((c) => c.kind === 'alacritty' && /AppData|APPDATA/i.test(c.path))).toBe(false)
  })
})

describe('resolveIncludePath (the include fence)', () => {
  const dir = '/cfg/ghostty'

  it('accepts a sibling file', () => {
    expect(resolveIncludePath(dir, 'local.conf')).toBe('/cfg/ghostty/local.conf')
    expect(resolveIncludePath(dir, './themes/x.conf')).toBe('/cfg/ghostty/themes/x.conf')
  })

  it('refuses every way out of the config directory', () => {
    expect(resolveIncludePath(dir, '../../etc/passwd')).toBeNull()
    expect(resolveIncludePath(dir, 'themes/../../../etc/passwd')).toBeNull()
    expect(resolveIncludePath(dir, '/etc/passwd')).toBeNull()
    expect(resolveIncludePath(dir, '~/.ssh/id_ed25519', { home: '/home/u' })).toBeNull()
    expect(resolveIncludePath(dir, 'x\0.conf')).toBeNull()
    expect(resolveIncludePath(dir, '..\\windows\\win.ini')).toBeNull()
    expect(resolveIncludePath(dir, '')).toBeNull()
  })

  it('refuses same-prefix siblings of the config directory', () => {
    // `/cfg/ghostty` must not treat `/cfg/ghostty-evil` or `/cfg/ghostty2` as inside.
    expect(resolveIncludePath(dir, '../ghostty-evil/x.conf')).toBeNull()
    expect(resolveIncludePath(dir, '../ghostty2/x.conf')).toBeNull()
    expect(resolveIncludePath('/cfg/ghostty', '/cfg/ghostty-evil/x.conf')).toBeNull()
    expect(resolveIncludePath('/cfg/ghostty', '/cfg/ghostty2/x.conf')).toBeNull()
  })

  it('accepts an absolute or ~-spelled path that still lands inside the directory', () => {
    // How people actually write an Alacritty import. Containment is the
    // property being enforced, not the spelling.
    expect(
      resolveIncludePath('/home/u/.config/alacritty', '/home/u/.config/alacritty/t.toml'),
    ).toBe('/home/u/.config/alacritty/t.toml')
    expect(
      resolveIncludePath('/home/u/.config/alacritty', '~/.config/alacritty/themes/t.toml', {
        home: '/home/u',
      }),
    ).toBe('/home/u/.config/alacritty/themes/t.toml')
  })

  it('expands ~ against home rather than dropping it', () => {
    // path.join semantics, not path.resolve: `~/x`.slice(1) is `/x`, and
    // resolve() would treat that as absolute and lose the home prefix.
    expect(resolveIncludePath('/home/u', '~/x', { home: '/home/u' })).toBe('/home/u/x')
    expect(resolveIncludePath('/home/u', '~/x.conf', { home: '/home/u' })).toBe('/home/u/x.conf')
  })

  it('refuses ~ expansion when no home is known', () => {
    expect(resolveIncludePath(dir, '~/x.conf')).toBeNull()
  })

  it('allows a backslash only on win32, where it is a real separator', () => {
    expect(resolveIncludePath(dir, 'themes\\x.toml', { platform: 'linux' })).toBeNull()
    expect(resolveIncludePath(dir, 'themes\\x.toml', { platform: 'win32' })).not.toBeNull()
  })
})

describe('readFenced', () => {
  it('reads a file inside the directory', () => {
    const dir = path.join(home, 'read-ok')
    write(path.join(dir, 'a.conf'), 'font-size = 9\n')
    expect(readFenced(dir, 'a.conf')).toBe('font-size = 9\n')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink pointing out of the directory', () => {
    const dir = path.join(home, 'read-link')
    fs.mkdirSync(dir, { recursive: true })
    const secret = write(path.join(outside, 'secret'), 'TOP SECRET\n')
    fs.symlinkSync(secret, path.join(dir, 'escape.conf'))
    // The lexical check passes — only the realpath check catches this.
    expect(resolveIncludePath(dir, 'escape.conf')).toBe(path.join(dir, 'escape.conf'))
    expect(readFenced(dir, 'escape.conf')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'follows a symlink that stays inside the directory',
    () => {
      const dir = path.join(home, 'read-link-in')
      write(path.join(dir, 'real.conf'), 'ok\n')
      fs.symlinkSync(path.join(dir, 'real.conf'), path.join(dir, 'alias.conf'))
      expect(readFenced(dir, 'alias.conf')).toBe('ok\n')
    },
  )

  it('reads a file exactly at the size cap', () => {
    const dir = path.join(home, 'read-cap')
    write(path.join(dir, 'cap.conf'), 'x'.repeat(MAX_CONFIG_BYTES))
    expect(readFenced(dir, 'cap.conf')).toHaveLength(MAX_CONFIG_BYTES)
  })

  it('refuses a file over the size cap and a directory', () => {
    const dir = path.join(home, 'read-big')
    write(path.join(dir, 'big.conf'), 'x'.repeat(MAX_CONFIG_BYTES + 1))
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    expect(readFenced(dir, 'big.conf')).toBeNull()
    expect(readFenced(dir, 'sub')).toBeNull()
    expect(readFenced(dir, 'missing.conf')).toBeNull()
  })
})

describe('includeTargets', () => {
  it('finds Ghostty config-file directives; optional `?` prefixes the value', () => {
    expect(
      includeTargets(
        'ghostty',
        'font-size = 1\nconfig-file = a.conf\nconfig-file = ?b.conf\nconfig-file = "?c.conf"\n',
      ),
    ).toEqual(['a.conf', 'b.conf', 'c.conf'])
    // The `?` is not a key prefix — `?config-file` is not an include directive.
    expect(includeTargets('ghostty', '?config-file = nope.conf\n')).toEqual([])
    expect(includeTargets('ghostty', 'config-file=a.conf\n')).toEqual(['a.conf'])
    expect(includeTargets('ghostty', 'config-file = "?optional.conf"\n')).toEqual(['optional.conf'])
    expect(includeTargets('ghostty', 'config-file = ?"quoted.conf"\n')).toEqual(['quoted.conf'])
  })

  it('does not treat a commented include as a target', () => {
    expect(includeTargets('ghostty', '# config-file = evil.conf\nfont-size = 1\n')).toEqual([])
    expect(includeTargets('kitty', '# include evil.conf\nfont_size 12\n')).toEqual([])
  })

  it('finds kitty includes and ignores map lines that merely mention one', () => {
    expect(includeTargets('kitty', 'include ./theme.conf\nmap f1 launch --include\n')).toEqual([
      './theme.conf',
    ])
  })

  it('finds Alacritty imports in TOML (multi-line) and legacy YAML', () => {
    expect(
      includeTargets('alacritty', '[general]\nimport = [\n  "themes/a.toml",\n  "b.toml",\n]\n'),
    ).toEqual(['themes/a.toml', 'b.toml'])
    expect(includeTargets('alacritty', 'import:\n  - ~/.config/alacritty/t.yml\n')).toEqual([
      '~/.config/alacritty/t.yml',
    ])
  })

  it('survives a CRLF-saved config', () => {
    // `$` under /m leaves the \r on the target; the lookup would then miss.
    expect(includeTargets('kitty', 'font_size 12\r\ninclude ./theme.conf\r\n')).toEqual([
      './theme.conf',
    ])
    expect(includeTargets('ghostty', 'config-file = local.conf\r\n')).toEqual(['local.conf'])
  })

  it('strips quotes so the key matches what the renderer parser looks up', () => {
    expect(includeTargets('kitty', 'include "theme.conf"\n')).toEqual(['theme.conf'])
    expect(includeTargets('alacritty', 'import = ["./themes/x.toml"]\n')).toEqual([
      './themes/x.toml',
    ])
  })

  it('has nothing to follow for Windows Terminal', () => {
    expect(includeTargets('windows-terminal', '{"schemes":[]}')).toEqual([])
  })
})

describe('includeRoots (the shared-directory carve-out)', () => {
  it("uses the config file's own directory in the normal case", () => {
    expect(includeRoots('ghostty', env(), '/somewhere/.config/ghostty')).toEqual([
      '/somewhere/.config/ghostty',
    ])
  })

  it('falls back to the emulator directory when the config sits in a shared one', () => {
    // ~/.alacritty.toml, or a dotfiles symlink whose real file is in $HOME:
    // fencing to $HOME itself would put ~/.ssh inside the fence.
    expect(includeRoots('alacritty', env(), home)).toEqual([path.join(home, '.config/alacritty')])
    expect(includeRoots('kitty', env(), path.join(home, '.config'))).toEqual([
      path.join(home, '.config/kitty'),
    ])
  })

  it('offers the XDG directory too when XDG_CONFIG_HOME is set', () => {
    expect(includeRoots('kitty', env({ env: { XDG_CONFIG_HOME: '/xdg' } }), home)).toEqual([
      '/xdg/kitty',
      path.join(home, '.config/kitty'),
    ])
  })

  it('has no include roots for Windows Terminal, which has no includes', () => {
    expect(includeRoots('windows-terminal', env(), home)).toEqual([])
  })
})

describe('readTerminalConfigs', () => {
  it('reads the first candidate per emulator with its fenced includes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-read-'))
    write(
      path.join(root, '.config/ghostty/config'),
      'font-size = 13\nconfig-file = local.conf\nconfig-file = ../../escape.conf\n',
    )
    write(path.join(root, '.config/ghostty/local.conf'), 'font-size = 14\n')
    write(path.join(root, 'escape.conf'), 'font-size = 99\n')
    write(path.join(root, '.config/kitty/kitty.conf'), 'font_size 12\ninclude ./theme.conf\n')
    write(path.join(root, '.config/kitty/theme.conf'), 'background #282828\n')

    const configs = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
    expect(configs.map((c) => c.kind).sort()).toEqual(['ghostty', 'kitty'])

    const ghostty = configs.find((c) => c.kind === 'ghostty')!
    expect(ghostty.path).toBe(path.join(root, '.config/ghostty/config'))
    expect(ghostty.includes).toEqual({ 'local.conf': 'font-size = 14\n' })
    // The escaping directive is simply absent — no throw, no partial read.
    expect(ghostty.includes['../../escape.conf']).toBeUndefined()

    const kitty = configs.find((c) => c.kind === 'kitty')!
    expect(kitty.includes['./theme.conf']).toBe('background #282828\n')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('returns nothing when no emulator is installed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-empty-'))
    expect(readTerminalConfigs({ home: root, platform: 'linux', env: {} })).toEqual([])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("refuses a $HOME config's include that reaches outside the emulator directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-homecfg-'))
    write(path.join(root, '.alacritty.toml'), 'import = [".ssh/id_rsa"]\n')
    write(path.join(root, '.ssh/id_rsa'), 'PRIVATE KEY MATERIAL\n')

    const configs = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
    expect(configs).toHaveLength(1)
    expect(configs[0].includes).toEqual({})
    expect(JSON.stringify(configs)).not.toContain('PRIVATE KEY MATERIAL')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it("still follows a $HOME config's include into the emulator config directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-homecfg2-'))
    write(path.join(root, '.alacritty.toml'), 'import = ["~/.config/alacritty/themes/x.toml"]\n')
    write(path.join(root, '.config/alacritty/themes/x.toml'), '[colors.primary]\n')

    const configs = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
    expect(configs[0].path).toBe(path.join(root, '.alacritty.toml'))
    expect(configs[0].includes['~/.config/alacritty/themes/x.toml']).toBe('[colors.primary]\n')

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('keys a Ghostty optional include by the path without the ?', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-opt-'))
    write(path.join(root, '.config/ghostty/config'), 'config-file = ?local.conf\n')
    write(path.join(root, '.config/ghostty/local.conf'), 'font-size = 14\n')
    const configs = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
    expect(configs[0].includes['local.conf']).toBe('font-size = 14\n')
    expect(configs[0].includes['?local.conf']).toBeUndefined()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'resolves includes next to the REAL file when the config is a dotfiles symlink',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-dot-'))
      write(path.join(root, 'dotfiles/ghostty/config'), 'config-file = theme.conf\n')
      write(path.join(root, 'dotfiles/ghostty/theme.conf'), 'background = #101010\n')
      fs.mkdirSync(path.join(root, '.config/ghostty'), { recursive: true })
      fs.symlinkSync(
        path.join(root, 'dotfiles/ghostty/config'),
        path.join(root, '.config/ghostty/config'),
      )
      const configs = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
      expect(configs[0].includes['theme.conf']).toBe('background = #101010\n')
      // The allowlisted path is what the UI shows, not the link target.
      expect(configs[0].path).toBe(path.join(root, '.config/ghostty/config'))
      fs.rmSync(root, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a primary symlink whose real basename is not a config',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-secret-'))
      const secret = write(path.join(outside, 'secret'), 'TOP SECRET\n')
      fs.mkdirSync(path.join(root, '.config/ghostty'), { recursive: true })
      fs.symlinkSync(secret, path.join(root, '.config/ghostty/config'))
      const configs = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
      expect(configs).toEqual([])
      expect(JSON.stringify(configs)).not.toContain('TOP SECRET')
      fs.rmSync(root, { recursive: true, force: true })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a primary symlink from ghostty/config to ~/.ssh/config',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-ssh-'))
      const ssh = write(path.join(root, '.ssh/config'), 'Host secret\n')
      fs.mkdirSync(path.join(root, '.config/ghostty'), { recursive: true })
      fs.symlinkSync(ssh, path.join(root, '.config/ghostty/config'))
      const configs = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
      expect(configs).toEqual([])
      expect(JSON.stringify(configs)).not.toContain('Host secret')
      fs.rmSync(root, { recursive: true, force: true })
    },
  )

  it('skips an oversize PRIMARY file and a directory at the candidate path without throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-primary-'))
    write(path.join(root, '.config/ghostty/config'), 'x'.repeat(MAX_CONFIG_BYTES + 1))
    fs.mkdirSync(path.join(root, '.config/kitty/kitty.conf'), { recursive: true })
    expect(() => readTerminalConfigs({ home: root, platform: 'linux', env: {} })).not.toThrow()
    expect(readTerminalConfigs({ home: root, platform: 'linux', env: {} })).toEqual([])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('accepts a PRIMARY file exactly at the size cap and refuses a multibyte file one byte over', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-term-cap-'))
    write(path.join(root, '.config/ghostty/config'), 'x'.repeat(MAX_CONFIG_BYTES))
    const exact = readTerminalConfigs({ home: root, platform: 'linux', env: {} })
    expect(exact).toHaveLength(1)
    expect(exact[0].text).toHaveLength(MAX_CONFIG_BYTES)

    const over = Buffer.concat([Buffer.alloc(MAX_CONFIG_BYTES - 1, 0x61), Buffer.from('é')])
    expect(over.length).toBe(MAX_CONFIG_BYTES + 1)
    fs.writeFileSync(path.join(root, '.config/ghostty/config'), over)
    expect(readTerminalConfigs({ home: root, platform: 'linux', env: {} })).toEqual([])
    fs.rmSync(root, { recursive: true, force: true })
  })
})
