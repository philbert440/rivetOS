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

  function writeCodexHooks(dir: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command:
                    '/opt/rivetos/integrations/codex/rivet-memory/bin/codex-memory-capture.sh --hook',
                  timeout: 10,
                },
              ],
            },
          ],
        },
      }),
    )
  }

  it('codex row warns without the native hook artefact', async () => {
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.1.0')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [codexHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
    expect(results[0].message).toMatch(/never captured yet/)
    expect(results[0].message).not.toMatch(/hooks:/)
    expect(results[0].detail).toMatch(/rivetos plugins install/)
  })

  it('codex row passes with hooks.json, last-capture, and user-hooks hint', async () => {
    writeCodexHooks(join(home, '.codex'))
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    writeFileSync(
      join(home, '.rivetos', 'codex-capture-state.json'),
      JSON.stringify({ lastIngestAt: '2026-09-12T12:00:00.000Z' }),
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
      now: new Date('2026-09-12T12:05:00.000Z'),
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
    expect(results[0].message).toMatch(/last capture: 5m ago/)
    expect(results[0].message).toMatch(/hooks: user \(trust once via \/hooks\)/)
    expect(results[0].message).not.toMatch(/capture watcher/)
  })

  it('codex row reports hooks: managed when requirements.toml carries our entry', async () => {
    const req = join(home, 'requirements.toml')
    writeFileSync(
      req,
      '[[hooks.Stop]]\ncommand = "/opt/rivetos/integrations/codex/rivet-memory/bin/codex-memory-capture.sh --hook"\n',
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
      codexRequirementsPath: req,
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
    expect(results[0].message).toMatch(/hooks: managed/)
    expect(results[0].message).toMatch(/never captured yet/)
  })

  function piHarness(h: string): DetectedHarness {
    return {
      id: 'pi',
      command: 'pi',
      binary: '/bin/pi',
      providerKey: 'pi-cli',
      configHome: join(h, '.pi', 'agent'),
    }
  }

  it('pi row warns when the extension file is absent', async () => {
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.85.1')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [piHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
    expect(results[0].message).toMatch(/never captured yet/)
    expect(results[0].detail).toMatch(/rivetos plugins install/)
  })

  it('pi row passes when the extension exists, even without a state file', async () => {
    mkdirSync(join(home, '.pi', 'agent', 'extensions'), { recursive: true })
    writeFileSync(
      join(home, '.pi', 'agent', 'extensions', 'rivet-memory.ts'),
      'export default {}\n',
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.85.1')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [piHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
    expect(results[0].message).toMatch(/never captured yet/)
    expect(results[0].message).not.toMatch(/capture watcher/)
  })

  it('pi row appends last capture from the state file without failing', async () => {
    mkdirSync(join(home, '.pi', 'agent', 'extensions'), { recursive: true })
    writeFileSync(
      join(home, '.pi', 'agent', 'extensions', 'rivet-memory.ts'),
      'export default {}\n',
    )
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    writeFileSync(
      join(home, '.rivetos', 'pi-capture-state.json'),
      JSON.stringify({ lastIngestAt: '2026-09-12T11:00:00.000Z' }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.85.1')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [piHarness(home)],
      exec,
      now: new Date('2026-09-12T12:00:00.000Z'),
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/last capture: 1h ago/)
  })

  it('a leftover systemd unit is not the installed marker', async () => {
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(join(home, '.config', 'systemd', 'user', 'pi-memory-capture.service'), '[Unit]\n')
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('0.85.1')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [piHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
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

  it('opencode row warns without the plugin file', async () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { rivetos: { type: 'local', command: ['bash', 'x'] } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
    expect(results[0].message).toMatch(/never captured yet/)
  })

  it('opencode row passes when the plugin file exists', async () => {
    mkdirSync(join(home, '.config', 'opencode', 'plugins'), { recursive: true })
    writeFileSync(
      join(home, '.config', 'opencode', 'plugins', 'rivet-memory.ts'),
      'export const RivetMemory = async () => ({})\n',
    )
    mkdirSync(join(home, '.rivetos'), { recursive: true })
    writeFileSync(
      join(home, '.rivetos', 'opencode-capture-state.json'),
      JSON.stringify({ lastIngestAt: 1_778_000_000_000 }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
      now: new Date(1_778_000_000_000 + 30_000),
    })
    expect(results[0].status).toBe('pass')
    expect(results[0].message).toMatch(/memory plugin installed/)
    expect(results[0].message).toMatch(/last capture: 30s ago/)
    expect(results[0].message).not.toMatch(/capture watcher/)
  })

  it('opencode MCP-only is not installed without the plugin file', async () => {
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(join(home, '.config', 'systemd', 'user', 'opencode-memory-capture.service'), '')
    writeFileSync(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { rivetos: { type: 'local', command: ['bash', 'x'] } } }),
    )
    const exec = vi.fn(async (_file: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === '--version') return ok('1.18.30')
      return ok()
    })
    const results = await checkHarnesses({
      home,
      root,
      detect: async () => [opencodeHarness(home)],
      exec,
    })
    expect(results[0].status).toBe('warn')
    expect(results[0].message).toMatch(/memory plugin not installed/)
  })
})
