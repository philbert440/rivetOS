import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkHarnesses } from './doctor.js'
import type { DetectedHarness, ExecResult } from '../lib/harness-detect.js'

function grokHarness(home: string): DetectedHarness {
  return {
    id: 'grok-build',
    command: 'grok',
    binary: '/bin/grok',
    providerKey: 'grok-cli',
    configHome: join(home, '.grok'),
  }
}

function claudeHarness(home: string): DetectedHarness {
  return {
    id: 'claude-code',
    command: 'claude',
    binary: '/bin/claude',
    providerKey: 'claude-cli',
    configHome: join(home, '.claude'),
  }
}

function ok(stdout = ''): ExecResult {
  return { stdout, stderr: '', code: 0, timedOut: false }
}

describe('checkHarnesses', () => {
  let home: string
  let root: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'doctor-harnesses-home-'))
    root = mkdtempSync(join(tmpdir(), 'doctor-harnesses-root-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('returns no rows at all when nothing is detected', async () => {
    const exec = vi.fn(async (): Promise<ExecResult> => ok())
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [],
      exec,
    })
    expect(results).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it('warns when a detected harness has no memory plugin', async () => {
    const exec = vi.fn(async (): Promise<ExecResult> => ok('1.0.0'))
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [grokHarness(home)],
      exec,
    })
    expect(results).toHaveLength(1)
    expect(results[0].category).toBe('harnesses')
    expect(results[0].name).toBe('grok-build')
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
    expect(results[0].detail).toMatch(/rivetos plugins install/)
  })

  it('passes when grok has the MCP block', async () => {
    mkdirSync(join(home, '.grok'), { recursive: true })
    writeFileSync(join(home, '.grok', 'config.toml'), '[mcp_servers.rivetos]\ncommand = "x"\n')
    const exec = vi.fn(async (): Promise<ExecResult> => ok('1.2.3'))
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [grokHarness(home)],
      exec,
    })
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
    expect(results[0].message).toMatch(/1\.2\.3/)
  })

  it('spawns --version with a 3s cap only when at least one binary was found', async () => {
    const exec = vi.fn(async (file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('9.9.9')
      return ok()
    })
    await checkHarnesses({
      home,
      root,
      detect: async () => [grokHarness(home)],
      exec,
    })
    const versionCalls = exec.mock.calls.filter((c) => c[1][0] === '--version')
    expect(versionCalls).toHaveLength(1)
    expect(versionCalls[0][0]).toBe('/bin/grok')
    expect(versionCalls[0][2]).toMatchObject({ timeoutMs: 3_000 })
  })

  it('passes claude when plugin list shows rivet-memory', async () => {
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'plugin' && args[1] === 'list') return ok('rivet-memory@rivetos')
      if (args[0] === '--version') return ok('1.0.0')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [claudeHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
  })

  it('passes claude when plugin list misses but hooks.js --status is active', async () => {
    const hooksJs = join(root, 'plugins', 'providers', 'claude-cli', 'dist', 'hooks.js')
    mkdirSync(dirname(hooksJs), { recursive: true })
    writeFileSync(hooksJs, '/* fake */\n')
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'plugin' && args[1] === 'list') return ok('other-plugin')
      if (args.includes('--status')) return ok('Capture hooks active.\n')
      if (args[0] === '--version') return ok('1.0.0')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [claudeHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('pass')
    expect(exec.mock.calls.some((c) => c[1].includes('--status'))).toBe(true)
  })

  function codexHarness(h: string): DetectedHarness {
    return {
      id: 'codex',
      command: 'codex',
      binary: '/bin/codex',
      providerKey: 'codex-cli',
      configHome: join(h, '.codex'),
    }
  }

  it('codex row reports capture watcher active/inactive', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex', 'mcp.json'),
      JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.1.0')
      if (args.includes('show')) return ok('NRestarts=0\nActiveState=active\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [codexHarness(home)],
      exec,
      platform: 'linux',
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
    expect(results[0].message).toMatch(/capture watcher: active/)
    expect(exec.mock.calls.some((c) => c[1]?.includes('NRestarts,ActiveState'))).toBe(true)

    const inactive = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.1.0')
      if (args.includes('show')) return ok('NRestarts=1\nActiveState=inactive\n')
      return ok()
    })
    const results2 = await checkHarnesses({
      home,
      root,
      detect: async () => [codexHarness(home)],
      exec: inactive,
      platform: 'linux',
    })
    expect(results2[0].status).toBe('warn')
    expect(results2[0].message).toMatch(/capture watcher: inactive/)
    expect(results2[0].message).toMatch(/memory plugin installed/)
  })

  it('codex row reports crash-looping when NRestarts > 3', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex', 'mcp.json'),
      JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.1.0')
      if (args.includes('show')) return ok('NRestarts=4\nActiveState=active\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [codexHarness(home)],
      exec,
      platform: 'linux',
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/capture watcher: crash-looping/)
  })

  it('codex row reports capture watcher n/a on win32', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex', 'mcp.json'),
      JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.1.0')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [codexHarness(home)],
      exec,
      platform: 'win32',
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/capture watcher: n\/a/)
    expect(exec.mock.calls.some((c) => String(c[0]).includes('systemctl'))).toBe(false)
  })

  it('codex launchd is active only when print shows state = running', async () => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(
      join(home, '.codex', 'mcp.json'),
      JSON.stringify({ mcpServers: { rivetos: { command: 'x' } } }),
    )
    const registered = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.1.0')
      if (args[0] === 'print') return ok('state = not running\npid = 0\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [codexHarness(home)],
      exec: registered,
      platform: 'darwin',
      uid: 501,
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/capture watcher: inactive/)

    const running = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.1.0')
      if (args[0] === 'print') return ok('state = running\npid = 1234\n')
      return ok()
    })
    const results2 = await checkHarnesses({
      home,
      root,
      detect: async () => [codexHarness(home)],
      exec: running,
      platform: 'darwin',
      uid: 501,
    })
    expect(results2[0].status).toBe('pass')
    expect(results2[0].message).toMatch(/capture watcher: active/)
  })

  it('warns for claude when neither plugin list nor hooks.js --status show installed', async () => {
    const hooksJs = join(root, 'plugins', 'providers', 'claude-cli', 'dist', 'hooks.js')
    mkdirSync(dirname(hooksJs), { recursive: true })
    writeFileSync(hooksJs, '/* fake */\n')
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'plugin' && args[1] === 'list') return ok('other-plugin')
      if (args.includes('--status')) return ok('Capture incomplete.\n')
      if (args[0] === '--version') return ok('1.0.0')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [claudeHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
  })

  function opencodeHarness(h: string): DetectedHarness {
    return {
      id: 'opencode',
      command: 'opencode',
      binary: '/bin/opencode',
      providerKey: 'opencode-cli',
      configHome: join(h, '.config', 'opencode'),
    }
  }

  it('opencode row warns when neither watcher unit nor state file is present', async () => {
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      if (args.includes('show')) return ok('NRestarts=0\nActiveState=inactive\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
      platform: 'linux',
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
    expect(results[0].message).toMatch(/capture watcher: inactive/)
  })

  it('opencode row warns when the state file exists but MCP artefact is missing', async () => {
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    writeFileSync(
      join(home, '.rivetos', 'opencode-capture-state.json'),
      JSON.stringify({ version: 1, partTimeUpdated: 1, messageTimeUpdated: 1 }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      if (args.includes('show')) return ok('NRestarts=0\nActiveState=active\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
      platform: 'linux',
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
  })

  it('opencode row passes when the capture state file exists and watcher is active', async () => {
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, '.rivetos', 'opencode-capture-state.json'),
      JSON.stringify({ version: 1, partTimeCreated: 1, messageTimeUpdated: 1 }),
    )
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { rivetos: { type: 'local', command: ['bash', 'x'] } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      if (args.includes('show')) return ok('NRestarts=0\nActiveState=active\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
      platform: 'linux',
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
    expect(results[0].message).toMatch(/capture watcher: active/)
    expect(exec.mock.calls.some((c) => c[1]?.includes('NRestarts,ActiveState'))).toBe(true)
  })

  it('opencode row passes when MCP lives in opencode.jsonc', async () => {
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, '.rivetos', 'opencode-capture-state.json'),
      JSON.stringify({ version: 1, partTimeUpdated: 1, messageTimeUpdated: 1 }),
    )
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.jsonc'),
      JSON.stringify({ mcp: { rivetos: { type: 'local', command: ['bash', 'x'] } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      if (args.includes('show')) return ok('NRestarts=0\nActiveState=active\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
      platform: 'linux',
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
  })

  it('opencode row passes when the systemd unit file exists even without a state file', async () => {
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(join(home, '.config', 'systemd', 'user', 'opencode-memory-capture.service'), '')
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { rivetos: { type: 'local', command: ['bash', 'x'] } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      if (args.includes('show')) return ok('NRestarts=0\nActiveState=active\n')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
      platform: 'linux',
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
  })
})
