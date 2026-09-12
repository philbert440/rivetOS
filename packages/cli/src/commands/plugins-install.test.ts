import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  bakeGrokHookCommands,
  createSyncCtx,
  mergeHermesConfig,
  posixShellQuote,
} from './plugins-sync.js'
import {
  CODEX_HOOK_COMMAND_SUFFIX,
  DEFAULT_ROSTER_COMMANDS,
  artefactConfigHomes,
  buildDenTermRoster,
  ensureEnvKey,
  ensureGrokMcpBlock,
  marketplaceRootWarning,
  mcpJsonHasRivetos,
  nativeCaptureArtefactMissing,
  opencodeJsonHasRivetos,
  parseInstallArgs,
  parseTomlTableKeys,
  planPluginsInstall,
  readEnvKey,
  runPluginsInstall,
  setupArtefactMissing,
  setupScriptEnv,
  tomlHasUncommentedTable,
  type TermRosterFile,
} from './plugins-install.js'
import type { DetectedHarness, ExecResult } from '../lib/harness-detect.js'

function grokHarness(home: string, binary = '/tmp/bin/grok'): DetectedHarness {
  return {
    id: 'grok-build',
    command: 'grok',
    binary,
    providerKey: 'grok-cli',
    configHome: join(home, '.grok'),
  }
}

function hermesHarness(home: string, binary = '/tmp/bin/hermes', venv?: string): DetectedHarness {
  return {
    id: 'hermes',
    command: 'hermes',
    binary,
    providerKey: 'hermes-cli',
    configHome: join(home, '.hermes'),
    venv,
  }
}

function claudeHarness(home: string, binary = '/tmp/bin/claude'): DetectedHarness {
  return {
    id: 'claude-code',
    command: 'claude',
    binary,
    providerKey: 'claude-cli',
    configHome: join(home, '.claude'),
  }
}

function kimiHarness(home: string, binary = '/tmp/bin/kimi'): DetectedHarness {
  return {
    id: 'kimi-code',
    command: 'kimi',
    binary,
    providerKey: 'kimi-code',
    configHome: join(home, '.kimi'),
  }
}

function codexHarness(home: string, binary = '/tmp/bin/codex'): DetectedHarness {
  return {
    id: 'codex',
    command: 'codex',
    binary,
    providerKey: 'codex-cli',
    configHome: join(home, '.codex'),
  }
}

function piHarness(home: string, binary = '/tmp/bin/pi'): DetectedHarness {
  return {
    id: 'pi',
    command: 'pi',
    binary,
    providerKey: 'pi-cli',
    configHome: join(home, '.pi', 'agent'),
  }
}

function opencodeHarness(home: string, binary = '/tmp/bin/opencode'): DetectedHarness {
  return {
    id: 'opencode',
    command: 'opencode',
    binary,
    providerKey: 'opencode-cli',
    configHome: join(home, '.config', 'opencode'),
  }
}

function okResult(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0, timedOut: false }
}

function failResult(stderr = 'nope'): ExecResult {
  return { stdout: '', stderr, code: 1, timedOut: false }
}

const CODEX_HOOK_COMMAND = `/opt/rivetos/integrations/codex/rivet-memory/bin/${CODEX_HOOK_COMMAND_SUFFIX}`

function writeCodexHooks(dir: string, command = CODEX_HOOK_COMMAND): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: '',
            hooks: [{ type: 'command', command, timeout: 10 }],
          },
        ],
      },
    }),
  )
}

function writeCodexMcp(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
  )
}

function writePiExtension(agentHome: string): void {
  const dir = join(agentHome, 'extensions')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rivet-memory.ts'), 'export default {}\n')
}

function writeOpencodePlugin(cfgHome: string): void {
  const dir = join(cfgHome, 'plugins')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'rivet-memory.ts'), 'export const RivetMemory = async () => ({})\n')
}

describe('parseInstallArgs', () => {
  it('parses repeated --harness, --dry-run, --root, --force', () => {
    expect(
      parseInstallArgs([
        '--dry-run',
        '--force',
        '--root',
        '/src/rivetos',
        '--harness',
        'grok-build',
        '--harness',
        'codex',
      ]),
    ).toEqual({
      dryRun: true,
      force: true,
      root: '/src/rivetos',
      harnesses: ['grok-build', 'codex'],
    })
  })

  it('rejects unknown harness ids', () => {
    expect(() => parseInstallArgs(['--harness', 'chatgpt'])).toThrow(/unknown --harness/)
  })
})

describe('ensureGrokMcpBlock', () => {
  const root = '/opt/rivetos'
  const command = `${root}/integrations/grok/rivet-memory/bin/rivet-memory-mcp.sh`

  it('appends the marker block when absent', () => {
    const out = ensureGrokMcpBlock('# existing\n', root)
    expect(out).toContain('[mcp_servers.rivetos]')
    expect(out).toContain(command)
    expect(out).toContain('# existing')
  })

  it('is idempotent when the marker is already present', () => {
    const once = ensureGrokMcpBlock('', root)
    const twice = ensureGrokMcpBlock(once, root)
    expect(twice).toBe(once)
    expect(twice.match(/\[mcp_servers\.rivetos\]/g)).toHaveLength(1)
  })

  it('does not duplicate when the marker sits among other tables', () => {
    const existing = '[mcp_servers.other]\ncommand = "x"\n\n[mcp_servers.rivetos]\ncommand = "y"\n'
    expect(ensureGrokMcpBlock(existing, root)).toBe(existing)
  })

  it('treats a quoted [mcp_servers."rivetos"] table as already present', () => {
    const existing = '[mcp_servers."rivetos"]\ncommand = "x"\n'
    expect(ensureGrokMcpBlock(existing, root)).toBe(existing)
    expect(tomlHasUncommentedTable(existing, 'mcp_servers.rivetos')).toBe(true)
    expect(parseTomlTableKeys('[mcp_servers."rivetos"]')).toEqual(['mcp_servers', 'rivetos'])
    expect(parseTomlTableKeys("[mcp_servers.'rivetos']")).toEqual(['mcp_servers', 'rivetos'])
    expect(parseTomlTableKeys('[ mcp_servers . "rivetos" ]')).toEqual(['mcp_servers', 'rivetos'])
  })

  it('does not treat [mcp_servers.rivetos] garbage as a table', () => {
    const garbage = '[mcp_servers.rivetos] garbage\ncommand = "x"\n'
    expect(tomlHasUncommentedTable(garbage, 'mcp_servers.rivetos')).toBe(false)
    const out = ensureGrokMcpBlock(garbage, root)
    expect(out).not.toBe(garbage)
    expect(tomlHasUncommentedTable(out, 'mcp_servers.rivetos')).toBe(true)
    expect(parseTomlTableKeys('[mcp_servers.rivetos] garbage')).toBeNull()
    expect(parseTomlTableKeys('[mcp_servers.rivetos] # comment')).toEqual([
      'mcp_servers',
      'rivetos',
    ])
  })

  it('decodes TOML unicode escapes in quoted table keys', () => {
    const existing = '[mcp_servers."rivet\\u006fs"]\ncommand = "x"\n'
    expect(parseTomlTableKeys('[mcp_servers."rivet\\u006fs"]')).toEqual(['mcp_servers', 'rivetos'])
    expect(tomlHasUncommentedTable(existing, 'mcp_servers.rivetos')).toBe(true)
    expect(ensureGrokMcpBlock(existing, root)).toBe(existing)
  })

  it('ignores a table header that only appears inside a multiline string', () => {
    const existing = 'instructions = """\n[mcp_servers.rivetos]\n"""\n'
    expect(tomlHasUncommentedTable(existing, 'mcp_servers.rivetos')).toBe(false)
    const out = ensureGrokMcpBlock(existing, root)
    expect(out).not.toBe(existing)
    expect(tomlHasUncommentedTable(out, 'mcp_servers.rivetos')).toBe(true)
  })

  it('ignores a table-shaped line inside a nested-array multiline string', () => {
    const existing = 'instructions = [\n  ["""\n[mcp_servers.rivetos]\n"""]\n]\n'
    expect(tomlHasUncommentedTable(existing, 'mcp_servers.rivetos')).toBe(false)
    const out = ensureGrokMcpBlock(existing, root)
    expect(out).not.toBe(existing)
    expect(tomlHasUncommentedTable(out, 'mcp_servers.rivetos')).toBe(true)
  })

  it('ignores the compact nested-array multiline form', () => {
    const existing = 'instructions = [["""\n[mcp_servers.rivetos]\n"""]]\n'
    expect(tomlHasUncommentedTable(existing, 'mcp_servers.rivetos')).toBe(false)
    const out = ensureGrokMcpBlock(existing, root)
    expect(out).not.toBe(existing)
    expect(tomlHasUncommentedTable(out, 'mcp_servers.rivetos')).toBe(true)
  })

  it('treats CRLF table headers as present and does not duplicate', () => {
    const existing = '[mcp_servers.rivetos]\r\ncommand = "x"\r\n'
    expect(tomlHasUncommentedTable(existing, 'mcp_servers.rivetos')).toBe(true)
    expect(ensureGrokMcpBlock(existing, root)).toBe(existing)
  })
})

describe('ensureEnvKey / readEnvKey', () => {
  it('appends a missing key and leaves an existing one alone', () => {
    expect(ensureEnvKey('', 'RIVETOS_PG_URL', 'postgres://x')).toBe('RIVETOS_PG_URL=postgres://x\n')
    const has = 'FOO=1\nRIVETOS_PG_URL=postgres://old\n'
    expect(ensureEnvKey(has, 'RIVETOS_PG_URL', 'postgres://new')).toBe(has)
  })

  it('accepts KEY=value, KEY = value, leading spaces, and export KEY=', () => {
    const forms = [
      'RIVETOS_PG_URL=postgres://a',
      'RIVETOS_PG_URL = postgres://b',
      '  RIVETOS_PG_URL=postgres://c',
      'export RIVETOS_PG_URL=postgres://d',
    ]
    for (const line of forms) {
      expect(ensureEnvKey(`${line}\n`, 'RIVETOS_PG_URL', 'postgres://new')).toBe(`${line}\n`)
    }
    expect(readEnvKey('RIVETOS_PG_URL=postgres://a\n', 'RIVETOS_PG_URL')).toBe('postgres://a')
    expect(readEnvKey('RIVETOS_PG_URL = postgres://b\n', 'RIVETOS_PG_URL')).toBe('postgres://b')
    expect(readEnvKey('  RIVETOS_PG_URL=postgres://c\n', 'RIVETOS_PG_URL')).toBe('postgres://c')
    expect(readEnvKey('export RIVETOS_PG_URL=postgres://d\n', 'RIVETOS_PG_URL')).toBe(
      'postgres://d',
    )
  })

  it('strips surrounding quotes on read and never appends a duplicate', () => {
    const quoted = 'RIVETOS_PG_URL="postgres://quoted"\n'
    expect(readEnvKey(quoted, 'RIVETOS_PG_URL')).toBe('postgres://quoted')
    expect(readEnvKey("RIVETOS_PG_URL='postgres://sq'\n", 'RIVETOS_PG_URL')).toBe('postgres://sq')
    expect(ensureEnvKey(quoted, 'RIVETOS_PG_URL', 'postgres://new')).toBe(quoted)
  })
})

describe('hermes yaml merge', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('merges memory.provider without clobbering existing hooks', () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    writeFileSync(
      join(dir, 'config.yaml'),
      'hooks:\n  on_session_end:\n    - command: existing-hook\nmodel: foo\n',
    )
    const ctx = createSyncCtx(false)
    mergeHermesConfig(ctx, dir, { memory: { provider: 'rivet_memory' } }, 'memory.provider')
    mergeHermesConfig(ctx, dir, { hooks: { on_session_end: [{ command: 'rivet-hook' }] } }, 'hooks')
    const parsed = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf-8')) as {
      memory?: { provider?: string }
      hooks?: { on_session_end?: Array<{ command?: string }> }
      model?: string
    }
    expect(parsed.memory?.provider).toBe('rivet_memory')
    expect(parsed.hooks?.on_session_end?.map((e) => e.command)).toEqual([
      'existing-hook',
      'rivet-hook',
    ])
    expect(parsed.model).toBe('foo')
  })

  it('is a no-op when memory.provider is already set', () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    const body = 'memory:\n  provider: rivet_memory\n'
    writeFileSync(join(dir, 'config.yaml'), body)
    const ctx = createSyncCtx(false)
    mergeHermesConfig(ctx, dir, { memory: { provider: 'rivet_memory' } }, 'memory.provider')
    expect(ctx.stats.written).toEqual([])
    expect(ctx.stats.unchanged).toBe(1)
  })

  it('keeps an existing non-empty different memory.provider and prints a kept row', () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    writeFileSync(join(dir, 'config.yaml'), 'memory:\n  provider: openai\nmodel: foo\n')
    const ctx = createSyncCtx(false)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    mergeHermesConfig(ctx, dir, { memory: { provider: 'rivet_memory' } }, 'memory.provider')
    const parsed = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf-8')) as {
      memory?: { provider?: string }
      model?: string
    }
    expect(parsed.memory?.provider).toBe('openai')
    expect(parsed.model).toBe('foo')
    expect(ctx.stats.written).toEqual([])
    expect(logs.some((l) => l.includes('kept') && l.includes('memory.provider'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('keeps an intentional empty-string memory.provider without --force', () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    writeFileSync(join(dir, 'config.yaml'), "memory:\n  provider: ''\nmodel: foo\n")
    const ctx = createSyncCtx(false)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    mergeHermesConfig(ctx, dir, { memory: { provider: 'rivet_memory' } }, 'memory.provider')
    const parsed = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf-8')) as {
      memory?: { provider?: string | null }
      model?: string
    }
    expect(parsed.memory?.provider).toBe('')
    expect(parsed.model).toBe('foo')
    expect(ctx.stats.written).toEqual([])
    expect(logs.some((l) => l.includes('kept') && l.includes('memory.provider'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('keeps a YAML-null memory.provider without --force', () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    writeFileSync(join(dir, 'config.yaml'), 'memory:\n  provider:\nmodel: foo\n')
    const ctx = createSyncCtx(false)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '))
    })
    mergeHermesConfig(ctx, dir, { memory: { provider: 'rivet_memory' } }, 'memory.provider')
    const parsed = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf-8')) as {
      memory?: { provider?: string | null }
      model?: string
    }
    expect(parsed.memory?.provider ?? null).toBeNull()
    expect(parsed.model).toBe('foo')
    expect(ctx.stats.written).toEqual([])
    expect(logs.some((l) => l.includes('kept') && l.includes('memory.provider'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('overwrites a different scalar when force is set', () => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-cfg-'))
    writeFileSync(join(dir, 'config.yaml'), 'memory:\n  provider: openai\n')
    const ctx = createSyncCtx(false)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mergeHermesConfig(ctx, dir, { memory: { provider: 'rivet_memory' } }, 'memory.provider', {
      force: true,
    })
    const parsed = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf-8')) as {
      memory?: { provider?: string }
    }
    expect(parsed.memory?.provider).toBe('rivet_memory')
    expect(ctx.stats.written).toHaveLength(1)
    vi.restoreAllMocks()
  })
})

describe('DEFAULT_ROSTER_COMMANDS', () => {
  it('copies each command string verbatim from den-server roster.ts', () => {
    const rosterSrc = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../services/den-server/src/term/roster.ts',
      ),
      'utf-8',
    )
    for (const [key, entry] of Object.entries(DEFAULT_ROSTER_COMMANDS)) {
      const snippet = entry.cmd.map((c) => `'${c}'`).join(', ')
      expect(rosterSrc, key).toContain(snippet)
    }
  })
})

describe('buildDenTermRoster', () => {
  it('lists detected harnesses plus shell and uses the absolute binary', () => {
    const roster = buildDenTermRoster(
      [
        grokHarness('/home/u', '/home/u/.local/bin/grok'),
        hermesHarness('/home/u', '/home/u/.local/bin/hermes'),
      ],
      '/home/u',
    )
    expect(roster).not.toBeNull()
    expect(Object.keys(roster!.commands).sort()).toEqual(['grok', 'hermes', 'shell'])
    expect(roster!.commands.shell.cmd).toEqual(['bash', '-l'])
    expect(roster!.commands.claude).toBeUndefined()
    expect(roster!.default).toBe('grok')
    expect(roster!.commands.grok.cmd[0]).toBe('/home/u/.local/bin/grok')
    expect(roster!.commands.grok.cmd.slice(1)).toEqual(['--permission-mode', 'bypassPermissions'])
    expect(roster!.commands.hermes.cmd).toEqual([
      '/home/u/.local/bin/hermes',
      '--yolo',
      '--accept-hooks',
    ])
    expect(roster!.cwd).toBe('/home/u')
  })

  it('defaults to claude when it is among the detected set', () => {
    const roster = buildDenTermRoster(
      [
        {
          id: 'claude-code',
          command: 'claude',
          binary: '/bin/claude',
          providerKey: 'claude-cli',
          configHome: '/home/u/.claude',
        },
        grokHarness('/home/u'),
      ],
      '/home/u',
    )
    expect(roster!.default).toBe('claude')
  })

  it('returns null when nothing was detected', () => {
    expect(buildDenTermRoster([], '/home/u')).toBeNull()
  })
})

describe('planPluginsInstall (dry-run plan)', () => {
  it('names the existing installer for each harness', () => {
    const plan = planPluginsInstall(
      [
        grokHarness('/home/u'),
        {
          id: 'kimi-code',
          command: 'kimi',
          binary: '/bin/kimi',
          providerKey: 'kimi-code',
          configHome: '/home/u/.kimi',
        },
        hermesHarness('/home/u'),
        {
          id: 'codex',
          command: 'codex',
          binary: '/bin/codex',
          providerKey: 'codex-cli',
          configHome: '/home/u/.codex',
        },
      ],
      '/opt/rivetos',
    )
    expect(plan.map((p) => p.id)).toEqual(['grok-build', 'kimi-code', 'hermes', 'codex'])
    expect(plan[0].steps.some((s) => s.includes('mcp_servers.rivetos'))).toBe(true)
    expect(plan[1].steps.some((s) => s.includes('setup-kimi-rivet-memory.sh'))).toBe(true)
    expect(plan[2].steps.some((s) => s.includes('memory.provider'))).toBe(true)
    expect(plan[3].steps.some((s) => s.includes('register Codex hooks (hooks.json)'))).toBe(true)
    expect(plan[3].steps.some((s) => s.includes('capture watcher'))).toBe(false)
  })

  it('names the pi setup script and extension', () => {
    const plan = planPluginsInstall([piHarness('/home/u')], '/opt/rivetos')
    expect(plan).toHaveLength(1)
    expect(plan[0].steps.some((s) => s.includes('setup-pi-rivet-memory.sh'))).toBe(true)
    expect(plan[0].steps.some((s) => s.includes('install pi extension'))).toBe(true)
    expect(plan[0].steps.some((s) => s.includes('capture watcher'))).toBe(false)
  })

  it('names the opencode installer and plugin', () => {
    const plan = planPluginsInstall(
      [
        {
          id: 'opencode',
          command: 'opencode',
          binary: '/bin/opencode',
          providerKey: 'opencode-cli',
          configHome: '/home/u/.config/opencode',
        },
      ],
      '/opt/rivetos',
    )
    expect(plan[0].id).toBe('opencode')
    expect(plan[0].steps.some((s) => s.includes('setup-opencode-rivet-memory.sh'))).toBe(true)
    expect(plan[0].steps.some((s) => s.includes('install OpenCode plugin'))).toBe(true)
    expect(plan[0].steps.some((s) => s.includes('capture watcher'))).toBe(false)
  })
})

describe('runPluginsInstall --dry-run', () => {
  let home: string
  let root: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugins-install-home-'))
    root = mkdtempSync(join(tmpdir(), 'plugins-install-root-'))
    mkdirSync(join(root, 'integrations'), { recursive: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('prints the plan and touches nothing', async () => {
    await runPluginsInstall(
      { dryRun: true, force: false, root, harnesses: [] },
      {
        home,
        detect: async () => [grokHarness(home, join(home, 'bin', 'grok'))],
      },
    )
    expect(existsSync(join(home, '.rivetos', 'den-term.json'))).toBe(false)
    expect(existsSync(join(home, '.grok', 'config.toml'))).toBe(false)
    const logs = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')
    expect(logs).toMatch(/grok-build/)
    expect(logs).toMatch(/dry-run|Would/)
    expect(logs).toMatch(/dev tree|shadow/)
  })

  it('writes den-term.json with detected harnesses plus shell (real run, --force)', async () => {
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      {
        home,
        detect: async () => [grokHarness(home, join(home, 'bin', 'grok'))],
      },
    )
    const dest = join(home, '.rivetos', 'den-term.json')
    expect(existsSync(dest)).toBe(true)
    const roster = JSON.parse(readFileSync(dest, 'utf-8')) as TermRosterFile
    expect(Object.keys(roster.commands).sort()).toEqual(['grok', 'shell'])
    expect(roster.commands.grok.cmd[0]).toBe(join(home, 'bin', 'grok'))
    expect(roster.commands.shell.cmd).toEqual(['bash', '-l'])
  })

  it('does not overwrite an existing den-term.json without --force', async () => {
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    const dest = join(home, '.rivetos', 'den-term.json')
    writeFileSync(
      dest,
      '{"default":"shell","commands":{"shell":{"label":"Shell","cmd":["bash"],"room":false}},"cwd":"/x","env":{}}\n',
    )
    await runPluginsInstall(
      { dryRun: false, force: false, root, harnesses: [] },
      {
        home,
        detect: async () => [grokHarness(home, join(home, 'bin', 'grok'))],
      },
    )
    const body = readFileSync(dest, 'utf-8')
    expect(body).toContain('"shell"')
    expect(JSON.parse(body).commands.grok).toBeUndefined()
  })
})

describe('marketplaceRootWarning', () => {
  const origRoot = process.env.RIVETOS_ROOT
  const origInstall = process.env.RIVETOS_INSTALL_ROOT

  afterEach(() => {
    if (origRoot === undefined) delete process.env.RIVETOS_ROOT
    else process.env.RIVETOS_ROOT = origRoot
    if (origInstall === undefined) delete process.env.RIVETOS_INSTALL_ROOT
    else process.env.RIVETOS_INSTALL_ROOT = origInstall
  })

  it('is silent for /opt/rivetos and for RIVETOS_INSTALL_ROOT / RIVETOS_ROOT', () => {
    delete process.env.RIVETOS_ROOT
    delete process.env.RIVETOS_INSTALL_ROOT
    expect(marketplaceRootWarning('/opt/rivetos')).toBeNull()
    process.env.RIVETOS_INSTALL_ROOT = '/opt/custom-install'
    expect(marketplaceRootWarning('/opt/custom-install')).toBeNull()
    delete process.env.RIVETOS_INSTALL_ROOT
    process.env.RIVETOS_ROOT = '/opt/from-env'
    expect(marketplaceRootWarning('/opt/from-env')).toBeNull()
  })

  it('names the dev-tree gotcha for any other root', () => {
    delete process.env.RIVETOS_ROOT
    delete process.env.RIVETOS_INSTALL_ROOT
    const msg = marketplaceRootWarning('/tmp/wt-dev-tree-gotcha')
    expect(msg).toMatch(/dev tree/)
    expect(msg).toMatch(/shadow/)
  })
})

describe('runPluginsInstall install paths (injected exec)', () => {
  let home: string
  let root: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plugins-install-exec-home-'))
    root = mkdtempSync(join(tmpdir(), 'plugins-install-exec-root-'))
    mkdirSync(join(root, 'integrations'), { recursive: true })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function logs(): string {
    return vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join('\n')
  }

  it('claude marketplace path: add + install, warns on a non-canonical root', async () => {
    const calls: Array<{ file: string; args: string[] }> = []
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      calls.push({ file, args })
      if (args[0] === 'plugin' && args[1] === 'list') return okResult('other-plugin')
      if (args[0] === 'plugin' && args[1] === 'marketplace') return okResult()
      if (args[0] === 'plugin' && args[1] === 'install') return okResult()
      return failResult(`unexpected ${args.join(' ')}`)
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [claudeHarness(home, '/bin/claude')], exec },
    )
    expect(
      calls.some(
        (c) => c.args[0] === 'plugin' && c.args[1] === 'marketplace' && c.args[3] === root,
      ),
    ).toBe(true)
    expect(calls.some((c) => c.args.join(' ') === 'plugin install rivet-memory@rivetos')).toBe(true)
    expect(logs()).toMatch(/dev tree|shadow/)
    expect(logs()).toMatch(/✅/)
  })

  it('claude fallback: ok only when hooks.js --install AND claude mcp add succeed', async () => {
    const hooksJs = join(root, 'plugins', 'providers', 'claude-cli', 'dist', 'hooks.js')
    mkdirSync(dirname(hooksJs), { recursive: true })
    writeFileSync(hooksJs, '/* fake hooks */\n')

    const run = async (hooksCode: number, mcpCode: number) => {
      vi.mocked(console.log).mockClear()
      const exec = async (file: string, args: string[]): Promise<ExecResult> => {
        if (args[0] === 'plugin' && args[1] === 'list') return failResult('no plugin subcommand')
        if (args.includes('--install'))
          return { stdout: '', stderr: '', code: hooksCode, timedOut: false }
        if (args[0] === 'mcp' && args[1] === 'add') {
          return {
            stdout: '',
            stderr: mcpCode === 0 ? '' : 'mcp failed',
            code: mcpCode,
            timedOut: false,
          }
        }
        return failResult(`unexpected ${file} ${args.join(' ')}`)
      }
      try {
        await runPluginsInstall(
          { dryRun: false, force: true, root, harnesses: [] },
          { home, detect: async () => [claudeHarness(home, '/bin/claude')], exec },
        )
        return { threw: false, logs: logs() }
      } catch {
        return { threw: true, logs: logs() }
      }
    }

    const both = await run(0, 0)
    expect(both.threw).toBe(false)
    expect(both.logs).toMatch(/✅/)
    expect(both.logs).toMatch(/hooks\.js --install/)

    const hooksFail = await run(1, 0)
    expect(hooksFail.threw).toBe(true)
    expect(hooksFail.logs).toMatch(/❌/)
    expect(hooksFail.logs).toMatch(/hooks\.js --install/)
    expect(hooksFail.logs).not.toMatch(/claude mcp add/)

    const mcpFail = await run(0, 1)
    expect(mcpFail.threw).toBe(true)
    expect(mcpFail.logs).toMatch(/❌/)
    expect(mcpFail.logs).toMatch(/claude mcp add/)

    const bothFail = await run(1, 1)
    expect(bothFail.threw).toBe(true)
    expect(bothFail.logs).toMatch(/hooks\.js --install/)
    expect(bothFail.logs).toMatch(/claude mcp add/)
  })

  it('runSetupScript passes argv + RIVETOS_ROOT and treats non-zero as not ok', async () => {
    const scriptRel = join(
      'integrations',
      'kimi',
      'rivet-memory',
      'bin',
      'setup-kimi-rivet-memory.sh',
    )
    const script = join(root, scriptRel)
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, '#!/bin/sh\nexit 0\n')

    const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = []
    const exec = async (
      file: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
    ): Promise<ExecResult> => {
      calls.push({ file, args, env: opts.env, cwd: opts.cwd })
      mkdirSync(join(home, '.kimi'), { recursive: true })
      writeFileSync(
        join(home, '.kimi', 'mcp.json'),
        JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
      )
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [kimiHarness(home)], exec },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('bash')
    expect(calls[0].args).toEqual([script, '--apply', '--force'])
    expect(calls[0].env?.RIVETOS_ROOT).toBe(root)
    expect(calls[0].env?.KIMI_BIN).toBe('/tmp/bin/kimi')
    expect(calls[0].env?.PATH?.split(':')[0]).toBe('/tmp/bin')
    expect(calls[0].cwd).toBe(root)
    expect(logs()).toMatch(/✅/)

    vi.mocked(console.log).mockClear()
    const failExec = async (): Promise<ExecResult> => failResult('setup exploded')
    await expect(
      runPluginsInstall(
        { dryRun: false, force: true, root, harnesses: [] },
        { home, detect: async () => [kimiHarness(home)], exec: failExec },
      ),
    ).rejects.toThrow(/failed/)
    expect(logs()).toMatch(/❌/)
    expect(logs()).toMatch(/setup-kimi-rivet-memory\.sh/)
  })

  it('setup child PATH sees a codex that lives only in a mise shim dir', async () => {
    const shimDir = join(home, '.local', 'share', 'mise', 'shims')
    const binary = join(shimDir, 'codex')
    const scriptRel = join(
      'integrations',
      'codex',
      'rivet-memory',
      'bin',
      'setup-codex-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const calls: Array<{ file: string; env?: NodeJS.ProcessEnv }> = []
    const exec = async (
      file: string,
      _args: string[],
      opts: { env?: NodeJS.ProcessEnv } = {},
    ): Promise<ExecResult> => {
      calls.push({ file, env: opts.env })
      if (file === 'bash') {
        writeCodexMcp(join(home, '.codex'))
        writeCodexHooks(join(home, '.codex'))
      }
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      {
        home,
        detect: async () => [codexHarness(home, binary)],
        exec,
        platform: 'linux',
      },
    )
    const bash = calls.find((c) => c.file === 'bash')
    expect(bash?.env?.CODEX_BIN).toBe(binary)
    const pathParts = (bash?.env?.PATH ?? '').split(':')
    expect(pathParts[0]).toBe(shimDir)
    expect(pathParts).toContain(join(home, '.local', 'share', 'mise', 'shims'))
    const env = setupScriptEnv(codexHarness(home, binary), root, home)
    expect(env.CODEX_BIN).toBe(binary)
    expect(env.PATH?.split(':')[0]).toBe(shimDir)
    expect(logs()).toMatch(/✅/)
  })

  it('hermes: pip only with venv, .env key once, yaml merged, provider kept', async () => {
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    writeFileSync(join(home, '.rivetos', '.env'), 'RIVETOS_PG_URL=postgres://from-rivetos\n')
    mkdirSync(join(home, '.hermes'), { recursive: true })
    writeFileSync(
      join(home, '.hermes', 'config.yaml'),
      'hooks:\n  on_session_end:\n    - command: existing-hook\nmemory:\n  provider: openai\n',
    )

    const pipCalls: string[][] = []
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      pipCalls.push([file, ...args])
      return okResult()
    }

    await expect(
      runPluginsInstall(
        { dryRun: false, force: false, root, harnesses: [] },
        { home, detect: async () => [hermesHarness(home)], exec },
      ),
    ).rejects.toThrow(/failed/)
    expect(pipCalls).toEqual([])
    const yaml = parseYaml(readFileSync(join(home, '.hermes', 'config.yaml'), 'utf-8')) as {
      memory?: { provider?: string }
      hooks?: { on_session_end?: Array<{ command?: string }> }
    }
    expect(yaml.memory?.provider).toBe('openai')
    expect(yaml.hooks?.on_session_end?.map((e) => e.command)).toContain('existing-hook')
    expect(logs()).toMatch(/kept/)
    expect(logs()).toMatch(/❌/)
    expect(logs()).toMatch(/no venv/)
    const envOnce = readFileSync(join(home, '.hermes', '.env'), 'utf-8')
    expect(envOnce).toContain('RIVETOS_PG_URL=postgres://from-rivetos')
    expect(envOnce.match(/RIVETOS_PG_URL/g)).toHaveLength(1)

    vi.mocked(console.log).mockClear()
    writeFileSync(
      join(home, '.hermes', '.env'),
      'export RIVETOS_PG_URL = "postgres://from-rivetos"\n',
    )
    await expect(
      runPluginsInstall(
        { dryRun: false, force: false, root, harnesses: [] },
        { home, detect: async () => [hermesHarness(home)], exec },
      ),
    ).rejects.toThrow(/failed/)
    const envTwice = readFileSync(join(home, '.hermes', '.env'), 'utf-8')
    expect(envTwice.match(/RIVETOS_PG_URL/g)).toHaveLength(1)

    const venv = join(home, '.hermes', 'hermes-agent', 'venv')
    mkdirSync(join(venv, 'bin'), { recursive: true })
    writeFileSync(join(venv, 'bin', 'pip'), '#!/bin/sh\n')
    const req = join(root, 'integrations', 'hermes', 'rivet-memory', 'requirements.txt')
    mkdirSync(dirname(req), { recursive: true })
    writeFileSync(req, 'psycopg[binary]>=3\n')
    // Don't create the plugin src dir — syncHermes would rsync it.
    pipCalls.length = 0
    vi.mocked(console.log).mockClear()
    await runPluginsInstall(
      { dryRun: false, force: false, root, harnesses: [] },
      {
        home,
        detect: async () => [hermesHarness(home, '/tmp/bin/hermes', venv)],
        exec,
      },
    )
    expect(pipCalls.some((c) => c[0] === join(venv, 'bin', 'pip') && c[1] === 'install')).toBe(true)
    expect(pipCalls.some((c) => c.includes('-r') && c.includes(req))).toBe(true)
  })

  it('setup script exit 0 without mcp.json is not installed', async () => {
    const scriptRel = join(
      'integrations',
      'kimi',
      'rivet-memory',
      'bin',
      'setup-kimi-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const exec = async (): Promise<ExecResult> => okResult()
    await expect(
      runPluginsInstall(
        { dryRun: false, force: true, root, harnesses: [] },
        { home, detect: async () => [kimiHarness(home)], exec },
      ),
    ).rejects.toThrow(/failed/)
    expect(logs()).toMatch(/❌/)
    expect(logs()).toMatch(/mcp\.json missing rivetos/)
  })

  it('merges rivetos into an existing mcp.json that only has other servers', async () => {
    const scriptRel = join(
      'integrations',
      'kimi',
      'rivet-memory',
      'bin',
      'setup-kimi-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    mkdirSync(join(home, '.kimi'), { recursive: true })
    writeFileSync(
      join(home, '.kimi', 'mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
    )
    const exec = async (): Promise<ExecResult> => okResult()
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [kimiHarness(home)], exec },
    )
    const mcp = JSON.parse(readFileSync(join(home, '.kimi', 'mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>
    }
    expect(mcp.mcpServers.other.command).toBe('other')
    expect(mcp.mcpServers.rivetos.command).toBe('/bin/bash')
    expect(mcp.mcpServers.rivetos.args?.[0]).toMatch(/rivet-memory-mcp\.sh/)
    expect(logs()).toMatch(/✅/)
  })

  it('hermes missing RIVETOS_PG_URL is not ok', async () => {
    const prevPg = process.env.RIVETOS_PG_URL
    const prevEnvFile = process.env.RIVETOS_ENV_FILE
    delete process.env.RIVETOS_PG_URL
    delete process.env.RIVETOS_ENV_FILE
    try {
      mkdirSync(join(home, '.rivetos'), { recursive: true })
      writeFileSync(join(home, '.rivetos', '.env'), 'OTHER=1\n')
      const venv = join(home, '.hermes', 'hermes-agent', 'venv')
      mkdirSync(join(venv, 'bin'), { recursive: true })
      writeFileSync(join(venv, 'bin', 'pip'), '#!/bin/sh\n')
      const req = join(root, 'integrations', 'hermes', 'rivet-memory', 'requirements.txt')
      mkdirSync(dirname(req), { recursive: true })
      writeFileSync(req, 'psycopg[binary]>=3\n')
      const exec = async (): Promise<ExecResult> => okResult()
      await expect(
        runPluginsInstall(
          { dryRun: false, force: false, root, harnesses: [] },
          {
            home,
            detect: async () => [hermesHarness(home, '/tmp/bin/hermes', venv)],
            exec,
          },
        ),
      ).rejects.toThrow(/failed/)
      expect(logs()).toMatch(/❌/)
      expect(logs()).toMatch(/RIVETOS_PG_URL missing/)
    } finally {
      if (prevPg === undefined) delete process.env.RIVETOS_PG_URL
      else process.env.RIVETOS_PG_URL = prevPg
      if (prevEnvFile === undefined) delete process.env.RIVETOS_ENV_FILE
      else process.env.RIVETOS_ENV_FILE = prevEnvFile
    }
  })

  it('codex: install finds hooks.json whose command ends with --hook', async () => {
    const scriptRel = join(
      'integrations',
      'codex',
      'rivet-memory',
      'bin',
      'setup-codex-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const exec = async (file: string): Promise<ExecResult> => {
      if (file === 'bash') {
        writeCodexMcp(join(home, '.codex'))
        writeCodexHooks(join(home, '.codex'))
      }
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [codexHarness(home)], exec, platform: 'linux' },
    )
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(true)
    expect(setupArtefactMissing('codex', home, join(home, '.codex'))).toBeNull()
    expect(logs()).toMatch(/✅/)
    expect(logs()).not.toMatch(/capture watcher/)
  })

  it('codex: MCP without hooks.json reports a precise missing message', async () => {
    const scriptRel = join(
      'integrations',
      'codex',
      'rivet-memory',
      'bin',
      'setup-codex-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const exec = async (file: string): Promise<ExecResult> => {
      if (file === 'bash') writeCodexMcp(join(home, '.codex'))
      return okResult()
    }
    await expect(
      runPluginsInstall(
        { dryRun: false, force: true, root, harnesses: [] },
        { home, detect: async () => [codexHarness(home)], exec, platform: 'linux' },
      ),
    ).rejects.toThrow(/failed/)
    expect(logs()).toMatch(/❌/)
    expect(logs()).toMatch(/hooks\.json missing codex-memory-capture\.sh --hook/)
  })

  it('codex: migration disables and removes a leftover user unit', async () => {
    const scriptRel = join(
      'integrations',
      'codex',
      'rivet-memory',
      'bin',
      'setup-codex-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const unitPath = join(home, '.config', 'systemd', 'user', 'codex-memory-capture.service')
    mkdirSync(dirname(unitPath), { recursive: true })
    writeFileSync(unitPath, '[Unit]\nDescription=legacy\n')
    const calls: Array<{ file: string; args: string[] }> = []
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      calls.push({ file, args })
      if (file === 'bash') {
        writeCodexMcp(join(home, '.codex'))
        writeCodexHooks(join(home, '.codex'))
      }
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [codexHarness(home)], exec, platform: 'linux' },
    )
    expect(
      calls.some(
        (c) =>
          c.file === 'systemctl' &&
          c.args.join(' ') === '--user disable --now codex-memory-capture.service',
      ),
    ).toBe(true)
    expect(existsSync(unitPath)).toBe(false)
    expect(logs()).toMatch(/removed legacy capture watcher/)
    expect(logs()).toMatch(/✅/)
  })

  it('codex: no leftover unit means no systemctl call', async () => {
    const scriptRel = join(
      'integrations',
      'codex',
      'rivet-memory',
      'bin',
      'setup-codex-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const calls: Array<{ file: string; args: string[] }> = []
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      calls.push({ file, args })
      if (file === 'bash') {
        writeCodexMcp(join(home, '.codex'))
        writeCodexHooks(join(home, '.codex'))
      }
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [codexHarness(home)], exec, platform: 'linux' },
    )
    expect(calls.some((c) => c.file === 'systemctl')).toBe(false)
    expect(logs()).not.toMatch(/removed legacy capture watcher/)
    expect(logs()).toMatch(/✅/)
  })

  it('pi: install finds the extension file', async () => {
    const scriptRel = join('integrations', 'pi', 'rivet-memory', 'bin', 'setup-pi-rivet-memory.sh')
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const exec = async (file: string): Promise<ExecResult> => {
      if (file === 'bash') {
        mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
        writeFileSync(
          join(home, '.pi', 'agent', 'mcp.json'),
          JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
        )
        writePiExtension(join(home, '.pi', 'agent'))
      }
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [piHarness(home)], exec, platform: 'linux' },
    )
    expect(existsSync(join(home, '.pi', 'agent', 'extensions', 'rivet-memory.ts'))).toBe(true)
    expect(setupArtefactMissing('pi', home, join(home, '.pi', 'agent'))).toBeNull()
    expect(logs()).toMatch(/✅/)
  })

  it('pi: MCP without extension reports a precise missing message', async () => {
    const scriptRel = join('integrations', 'pi', 'rivet-memory', 'bin', 'setup-pi-rivet-memory.sh')
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const exec = async (file: string): Promise<ExecResult> => {
      if (file === 'bash') {
        mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
        writeFileSync(
          join(home, '.pi', 'agent', 'mcp.json'),
          JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
        )
      }
      return okResult()
    }
    await expect(
      runPluginsInstall(
        { dryRun: false, force: true, root, harnesses: [] },
        { home, detect: async () => [piHarness(home)], exec, platform: 'linux' },
      ),
    ).rejects.toThrow(/failed/)
    expect(logs()).toMatch(/❌/)
    expect(logs()).toMatch(/pi extension missing/)
  })

  it('opencode: install finds the plugin file', async () => {
    const scriptRel = join(
      'integrations',
      'opencode',
      'rivet-memory',
      'bin',
      'setup-opencode-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const exec = async (file: string): Promise<ExecResult> => {
      if (file === 'bash') {
        mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
        writeFileSync(
          join(home, '.config', 'opencode', 'opencode.json'),
          JSON.stringify({
            mcp: { rivetos: { type: 'local', command: ['bash', 'x'], enabled: true } },
          }),
        )
        writeOpencodePlugin(join(home, '.config', 'opencode'))
      }
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [opencodeHarness(home)], exec, platform: 'linux' },
    )
    expect(existsSync(join(home, '.config', 'opencode', 'plugins', 'rivet-memory.ts'))).toBe(true)
    expect(setupArtefactMissing('opencode', home, join(home, '.config', 'opencode'))).toBeNull()
    expect(logs()).toMatch(/✅/)
  })

  it('opencode: MCP without plugin reports a precise missing message', async () => {
    const scriptRel = join(
      'integrations',
      'opencode',
      'rivet-memory',
      'bin',
      'setup-opencode-rivet-memory.sh',
    )
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const exec = async (file: string): Promise<ExecResult> => {
      if (file === 'bash') {
        mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
        writeFileSync(
          join(home, '.config', 'opencode', 'opencode.json'),
          JSON.stringify({
            mcp: { rivetos: { type: 'local', command: ['bash', 'x'], enabled: true } },
          }),
        )
      }
      return okResult()
    }
    await expect(
      runPluginsInstall(
        { dryRun: false, force: true, root, harnesses: [] },
        { home, detect: async () => [opencodeHarness(home)], exec, platform: 'linux' },
      ),
    ).rejects.toThrow(/failed/)
    expect(logs()).toMatch(/❌/)
    expect(logs()).toMatch(/OpenCode plugin missing/)
  })

  it('pi: migration bootouts and removes a leftover launchd plist', async () => {
    const scriptRel = join('integrations', 'pi', 'rivet-memory', 'bin', 'setup-pi-rivet-memory.sh')
    mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
    writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
    const plistPath = join(home, 'Library', 'LaunchAgents', 'dev.rivetos.pi-capture.plist')
    mkdirSync(dirname(plistPath), { recursive: true })
    writeFileSync(plistPath, '<plist></plist>\n')
    const calls: Array<{ file: string; args: string[] }> = []
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      calls.push({ file, args })
      if (file === 'bash') {
        mkdirSync(join(home, '.pi', 'agent'), { recursive: true })
        writeFileSync(
          join(home, '.pi', 'agent', 'mcp.json'),
          JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
        )
        writePiExtension(join(home, '.pi', 'agent'))
      }
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: true, root, harnesses: [] },
      { home, detect: async () => [piHarness(home)], exec, platform: 'darwin', uid: 501 },
    )
    expect(
      calls.some(
        (c) =>
          c.file === 'launchctl' && c.args.join(' ') === 'bootout gui/501/dev.rivetos.pi-capture',
      ),
    ).toBe(true)
    expect(existsSync(plistPath)).toBe(false)
    expect(logs()).toMatch(/removed legacy capture watcher/)
  })

  it('runSetupScript without --force does not forward --force', async () => {
    const scriptRel = join(
      'integrations',
      'kimi',
      'rivet-memory',
      'bin',
      'setup-kimi-rivet-memory.sh',
    )
    const script = join(root, scriptRel)
    mkdirSync(dirname(script), { recursive: true })
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    const calls: string[][] = []
    const exec = async (file: string, args: string[]): Promise<ExecResult> => {
      calls.push([file, ...args])
      mkdirSync(join(home, '.kimi'), { recursive: true })
      writeFileSync(
        join(home, '.kimi', 'mcp.json'),
        JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
      )
      return okResult()
    }
    await runPluginsInstall(
      { dryRun: false, force: false, root, harnesses: [] },
      { home, detect: async () => [kimiHarness(home)], exec },
    )
    expect(calls[0]).toEqual(['bash', script, '--apply'])
  })

  it('codex: verifies the CODEX_HOME artefact, not only ~/.codex', async () => {
    const prev = process.env.CODEX_HOME
    const custom = join(home, 'custom-codex')
    process.env.CODEX_HOME = custom
    try {
      const scriptRel = join(
        'integrations',
        'codex',
        'rivet-memory',
        'bin',
        'setup-codex-rivet-memory.sh',
      )
      mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
      writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
      mkdirSync(custom, { recursive: true })
      writeCodexMcp(custom)
      writeCodexHooks(custom)
      const exec = async (): Promise<ExecResult> => okResult()
      await runPluginsInstall(
        { dryRun: false, force: true, root, harnesses: [] },
        {
          home,
          detect: async () => [codexHarness(home)],
          exec,
          platform: 'linux',
        },
      )
      expect(logs()).toMatch(/✅/)
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  it('codex: an override home is exclusive — a marker only in ~/.codex is not enough', async () => {
    const prev = process.env.CODEX_HOME
    const custom = join(home, 'custom-codex')
    process.env.CODEX_HOME = custom
    try {
      const scriptRel = join(
        'integrations',
        'codex',
        'rivet-memory',
        'bin',
        'setup-codex-rivet-memory.sh',
      )
      mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
      writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
      mkdirSync(join(home, '.codex'), { recursive: true })
      const defaultMcp = JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } })
      writeFileSync(join(home, '.codex', 'mcp.json'), defaultMcp)
      mkdirSync(custom, { recursive: true })
      const exec = async (file: string): Promise<ExecResult> => {
        if (file === 'systemctl') {
          return { stdout: '', stderr: 'spawn systemctl ENOENT', code: null, timedOut: false }
        }
        return okResult()
      }
      await expect(
        runPluginsInstall(
          { dryRun: false, force: true, root, harnesses: [] },
          {
            home,
            detect: async () => [codexHarness(home)],
            exec,
            platform: 'linux',
          },
        ),
      ).rejects.toThrow(/failed/)
      expect(setupArtefactMissing('codex', home, join(home, '.codex'))).toMatch(/missing rivetos/)
      expect(readFileSync(join(home, '.codex', 'mcp.json'), 'utf-8')).toBe(defaultMcp)
      expect(existsSync(join(custom, 'mcp.json'))).toBe(false)
      expect(logs()).toMatch(/❌/)
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  it('codex: repair under CODEX_HOME does not rewrite ~/.codex', async () => {
    const prev = process.env.CODEX_HOME
    const custom = join(home, 'custom-codex')
    process.env.CODEX_HOME = custom
    try {
      const scriptRel = join(
        'integrations',
        'codex',
        'rivet-memory',
        'bin',
        'setup-codex-rivet-memory.sh',
      )
      mkdirSync(dirname(join(root, scriptRel)), { recursive: true })
      writeFileSync(join(root, scriptRel), '#!/bin/sh\nexit 0\n')
      mkdirSync(join(home, '.codex'), { recursive: true })
      const defaultMcp = JSON.stringify({ mcpServers: { other: { command: 'default' } } })
      writeFileSync(join(home, '.codex', 'mcp.json'), defaultMcp)
      mkdirSync(custom, { recursive: true })
      writeFileSync(
        join(custom, 'mcp.json'),
        JSON.stringify({ mcpServers: { other: { command: 'custom' } } }),
      )
      writeCodexHooks(custom)
      const exec = async (): Promise<ExecResult> => okResult()
      await runPluginsInstall(
        { dryRun: false, force: true, root, harnesses: [] },
        {
          home,
          detect: async () => [codexHarness(home)],
          exec,
          platform: 'linux',
        },
      )
      expect(readFileSync(join(home, '.codex', 'mcp.json'), 'utf-8')).toBe(defaultMcp)
      expect(
        JSON.parse(readFileSync(join(custom, 'mcp.json'), 'utf-8')).mcpServers.rivetos,
      ).toBeDefined()
      expect(logs()).toMatch(/✅/)
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prev
    }
  })

  it('hermes: process.env PG URL is used when ~/.rivetos/.env lacks the key', async () => {
    const prevPg = process.env.RIVETOS_PG_URL
    const prevEnvFile = process.env.RIVETOS_ENV_FILE
    delete process.env.RIVETOS_ENV_FILE
    process.env.RIVETOS_PG_URL = 'postgres://192.0.2.1/from-env'
    try {
      mkdirSync(join(home, '.rivetos'), { recursive: true })
      writeFileSync(join(home, '.rivetos', '.env'), 'OTHER=1\n')
      const venv = join(home, '.hermes', 'hermes-agent', 'venv')
      mkdirSync(join(venv, 'bin'), { recursive: true })
      writeFileSync(join(venv, 'bin', 'pip'), '#!/bin/sh\n')
      const req = join(root, 'integrations', 'hermes', 'rivet-memory', 'requirements.txt')
      mkdirSync(dirname(req), { recursive: true })
      writeFileSync(req, 'psycopg[binary]>=3\n')
      const exec = async (): Promise<ExecResult> => okResult()
      await runPluginsInstall(
        { dryRun: false, force: false, root, harnesses: [] },
        {
          home,
          detect: async () => [hermesHarness(home, '/tmp/bin/hermes', venv)],
          exec,
        },
      )
      expect(readFileSync(join(home, '.hermes', '.env'), 'utf-8')).toContain(
        'postgres://192.0.2.1/from-env',
      )
      expect(logs()).toMatch(/✅/)
    } finally {
      if (prevPg === undefined) delete process.env.RIVETOS_PG_URL
      else process.env.RIVETOS_PG_URL = prevPg
      if (prevEnvFile === undefined) delete process.env.RIVETOS_ENV_FILE
      else process.env.RIVETOS_ENV_FILE = prevEnvFile
    }
  })

  it('hermes: empty destination assignment is replaced; nonempty user value is kept', async () => {
    const prevPg = process.env.RIVETOS_PG_URL
    const prevEnvFile = process.env.RIVETOS_ENV_FILE
    delete process.env.RIVETOS_PG_URL
    delete process.env.RIVETOS_ENV_FILE
    try {
      mkdirSync(join(home, '.rivetos'), { recursive: true })
      writeFileSync(join(home, '.rivetos', '.env'), 'RIVETOS_PG_URL=postgres://192.0.2.1/src\n')
      mkdirSync(join(home, '.hermes'), { recursive: true })
      writeFileSync(join(home, '.hermes', '.env'), 'RIVETOS_PG_URL=\n')
      const venv = join(home, '.hermes', 'hermes-agent', 'venv')
      mkdirSync(join(venv, 'bin'), { recursive: true })
      writeFileSync(join(venv, 'bin', 'pip'), '#!/bin/sh\n')
      const req = join(root, 'integrations', 'hermes', 'rivet-memory', 'requirements.txt')
      mkdirSync(dirname(req), { recursive: true })
      writeFileSync(req, 'psycopg[binary]>=3\n')
      const exec = async (): Promise<ExecResult> => okResult()
      await runPluginsInstall(
        { dryRun: false, force: false, root, harnesses: [] },
        {
          home,
          detect: async () => [hermesHarness(home, '/tmp/bin/hermes', venv)],
          exec,
        },
      )
      expect(readFileSync(join(home, '.hermes', '.env'), 'utf-8')).toContain(
        'RIVETOS_PG_URL=postgres://192.0.2.1/src',
      )

      writeFileSync(join(home, '.hermes', '.env'), 'RIVETOS_PG_URL=postgres://192.0.2.1/user\n')
      vi.mocked(console.log).mockClear()
      await runPluginsInstall(
        { dryRun: false, force: false, root, harnesses: [] },
        {
          home,
          detect: async () => [hermesHarness(home, '/tmp/bin/hermes', venv)],
          exec,
        },
      )
      expect(readFileSync(join(home, '.hermes', '.env'), 'utf-8')).toContain(
        'postgres://192.0.2.1/user',
      )
      expect(readFileSync(join(home, '.hermes', '.env'), 'utf-8')).not.toContain(
        'postgres://192.0.2.1/src',
      )
    } finally {
      if (prevPg === undefined) delete process.env.RIVETOS_PG_URL
      else process.env.RIVETOS_PG_URL = prevPg
      if (prevEnvFile === undefined) delete process.env.RIVETOS_ENV_FILE
      else process.env.RIVETOS_ENV_FILE = prevEnvFile
    }
  })

})

describe('artefact validation + grok hook bake', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects malformed JSON that merely contains the rivetos substring', () => {
    dir = mkdtempSync(join(tmpdir(), 'artefact-'))
    const mcp = join(dir, 'mcp.json')
    writeFileSync(mcp, '{ rivetos: not-json, }\n')
    expect(mcpJsonHasRivetos(mcp)).toBe(false)
    expect(opencodeJsonHasRivetos(mcp)).toBe(false)
    expect(setupArtefactMissing('codex', dir, dir)).toMatch(/missing rivetos/)
  })

  it('treats opencode.jsonc mcp.rivetos as the OpenCode artefact', () => {
    dir = mkdtempSync(join(tmpdir(), 'artefact-'))
    const cfgHome = join(dir, '.config', 'opencode')
    mkdirSync(cfgHome, { recursive: true })
    writeFileSync(
      join(cfgHome, 'opencode.jsonc'),
      JSON.stringify({ mcp: { rivetos: { type: 'local', command: ['bash', 'x'] } } }),
    )
    expect(opencodeJsonHasRivetos(join(cfgHome, 'opencode.json'))).toBe(true)
    expect(setupArtefactMissing('opencode', dir, cfgHome)).toMatch(/OpenCode plugin missing/)
    writeOpencodePlugin(cfgHome)
    expect(setupArtefactMissing('opencode', dir, cfgHome)).toBeNull()
  })

  it('rejects a commented TOML table', () => {
    dir = mkdtempSync(join(tmpdir(), 'artefact-'))
    writeFileSync(join(dir, 'config.toml'), '# [mcp_servers.rivetos]\ncommand = "x"\n')
    expect(setupArtefactMissing('codex', dir, dir)).toMatch(/missing rivetos/)
    writeFileSync(join(dir, 'config.toml'), '[mcp_servers.rivetos] garbage\ncommand = "x"\n')
    expect(setupArtefactMissing('codex', dir, dir)).toMatch(/missing rivetos/)
    writeFileSync(join(dir, 'config.toml'), '[mcp_servers."rivetos"]\ncommand = "x"\n')
    expect(setupArtefactMissing('codex', dir, dir)).toMatch(/hooks\.json missing/)
    writeCodexHooks(dir)
    expect(setupArtefactMissing('codex', dir, dir)).toBeNull()
  })

  it('nativeCaptureArtefactMissing requires a command ending with the hook suffix', () => {
    dir = mkdtempSync(join(tmpdir(), 'artefact-'))
    writeCodexHooks(dir, '/opt/rivetos/bin/codex-memory-capture.sh --watch')
    expect(nativeCaptureArtefactMissing('codex', dir, dir)).toMatch(/hooks\.json missing/)
    writeCodexHooks(dir)
    expect(nativeCaptureArtefactMissing('codex', dir, dir)).toBeNull()
  })

  it('managed requirements.toml counts as the Codex native artefact', () => {
    dir = mkdtempSync(join(tmpdir(), 'artefact-'))
    const req = join(dir, 'requirements.toml')
    writeFileSync(req, `[[hooks.Stop]]\ncommand = "${CODEX_HOOK_COMMAND}"\n`)
    expect(
      nativeCaptureArtefactMissing('codex', dir, dir, { codexRequirementsPath: req }),
    ).toBeNull()
    writeFileSync(req, '# command = "codex-memory-capture.sh --hook"\n')
    expect(
      nativeCaptureArtefactMissing('codex', dir, dir, { codexRequirementsPath: req }),
    ).toMatch(/hooks\.json missing/)
  })

  it('bakes the selected root into copied Grok hook commands', () => {
    dir = mkdtempSync(join(tmpdir(), 'grok-hooks-'))
    const hook = join(dir, 'rivet-memory.json')
    writeFileSync(
      hook,
      JSON.stringify({
        hooks: {
          SessionEnd: [
            {
              command:
                '${RIVETOS_ROOT:-/opt/rivetos}/integrations/grok/rivet-memory/bin/grok-memory-hook.sh SessionEnd',
            },
          ],
        },
      }),
    )
    expect(bakeGrokHookCommands(hook, '/custom/tree')).toBe(true)
    const body = readFileSync(hook, 'utf-8')
    expect(body).toContain('/custom/tree/integrations/grok/rivet-memory/bin/grok-memory-hook.sh')
    expect(body).not.toContain('${RIVETOS_ROOT:-/opt/rivetos}')
    expect(JSON.parse(body).hooks.SessionEnd[0].command).toContain(
      posixShellQuote('/custom/tree/integrations/grok/rivet-memory/bin/grok-memory-hook.sh'),
    )
  })

  it('shell-quotes a baked root that contains spaces or quotes and round-trips JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'grok-hooks-'))
    const hook = join(dir, 'rivet-memory.json')
    const template = {
      hooks: {
        SessionEnd: [
          {
            command:
              '${RIVETOS_ROOT:-/opt/rivetos}/integrations/grok/rivet-memory/bin/grok-memory-hook.sh SessionEnd',
          },
        ],
      },
    }
    writeFileSync(hook, JSON.stringify(template))
    expect(bakeGrokHookCommands(hook, '/home/u/Rivet OS')).toBe(true)
    const spaced = JSON.parse(readFileSync(hook, 'utf-8')) as typeof template
    expect(spaced.hooks.SessionEnd[0].command).toBe(
      `'${'/home/u/Rivet OS/integrations/grok/rivet-memory/bin/grok-memory-hook.sh'}' SessionEnd`,
    )

    writeFileSync(hook, JSON.stringify(template))
    const quotedRoot = '/home/u/Rivet "OS"'
    expect(bakeGrokHookCommands(hook, quotedRoot)).toBe(true)
    const quoted = JSON.parse(readFileSync(hook, 'utf-8')) as typeof template
    const exe = `${quotedRoot}/integrations/grok/rivet-memory/bin/grok-memory-hook.sh`
    expect(quoted.hooks.SessionEnd[0].command).toBe(`${posixShellQuote(exe)} SessionEnd`)
  })

  it('artefactConfigHomes uses only the env override when set', () => {
    const prevCodex = process.env.CODEX_HOME
    const prevKimi = process.env.KIMI_CODE_HOME
    const home = '/home/u'
    try {
      process.env.CODEX_HOME = '/custom/codex'
      process.env.KIMI_CODE_HOME = '/custom/kimi'
      expect(artefactConfigHomes('codex', home, join(home, '.codex'))).toEqual(['/custom/codex'])
      expect(artefactConfigHomes('kimi-code', home, join(home, '.kimi'))).toEqual(['/custom/kimi'])
      delete process.env.CODEX_HOME
      delete process.env.KIMI_CODE_HOME
      expect(artefactConfigHomes('codex', home, join(home, '.codex'))).toEqual([
        join(home, '.codex'),
      ])
      expect(artefactConfigHomes('kimi-code', home, join(home, '.kimi'))).toEqual([
        join(home, '.kimi'),
        join(home, '.kimi-code'),
      ])
    } finally {
      if (prevCodex === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = prevCodex
      if (prevKimi === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = prevKimi
    }
  })
})
