/**
 * rivetos test
 *
 * Quick smoke test — verifies the system works end-to-end.
 *
 * Tests:
 *   1. Config loads and validates
 *   2. Provider responds (minimal prompt, ~5 tokens)
 *   3. Memory backend connects (SELECT 1)
 *   4. Tool registry accessible
 *   5. Health endpoint responds
 *   6. Shared storage writable (if mounted)
 *
 * Usage:
 *   rivetos test               Run all tests
 *   rivetos test --quick       Skip provider test (saves tokens)
 *   rivetos test --verbose     Show detailed output
 *   rivetos test --json        Output results as JSON
 */

import { readFile, access, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateConfig } from '@rivetos/boot'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string
  status: 'pass' | 'fail' | 'skip'
  durationMs: number
  message: string
  detail?: string
}

interface TestOptions {
  quick: boolean
  verbose: boolean
  json: boolean
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseArgs(): TestOptions {
  const args = process.argv.slice(3)
  const opts: TestOptions = { quick: false, verbose: false, json: false }

  for (const arg of args) {
    switch (arg) {
      case '--quick':
      case '-q':
        opts.quick = true
        break
      case '--verbose':
      case '-v':
        opts.verbose = true
        break
      case '--json':
        opts.json = true
        break
      case '--help':
      case '-h':
        showHelp()
        process.exit(0)
        break
    }
  }

  return opts
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

async function runTest(
  name: string,
  fn: () => Promise<{ pass: boolean; message: string; detail?: string }>,
): Promise<TestResult> {
  const start = Date.now()
  try {
    const result = await fn()
    return {
      name,
      status: result.pass ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      message: result.message,
      detail: result.detail,
    }
  } catch (err) {
    return {
      name,
      status: 'fail',
      durationMs: Date.now() - start,
      message: (err as Error).message,
      detail: (err as Error).stack,
    }
  }
}

function skip(name: string, reason: string): TestResult {
  return { name, status: 'skip', durationMs: 0, message: reason }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testConfig(): Promise<{ pass: boolean; message: string; detail?: string }> {
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  const raw = await readFile(configPath, 'utf-8')
  const parsed = parseYaml(raw) as Record<string, unknown>
  const result = validateConfig(parsed)

  if (result.valid) {
    return { pass: true, message: 'Config loads and validates' }
  }
  return {
    pass: false,
    message: `Config has ${result.errors.length} error(s)`,
    detail: result.errors.map((e) => `[${e.path}] ${e.message}`).join('\n'),
  }
}

async function testProvider(): Promise<{ pass: boolean; message: string; detail?: string }> {
  const configPath = resolve(process.env.HOME ?? '.', '.rivetos', 'config.yaml')
  const raw = await readFile(configPath, 'utf-8')
  const parsed = parseYaml(raw) as Record<string, unknown>
  const providers = (parsed.providers ?? {}) as Partial<Record<string, Record<string, unknown>>>

  // Find the first configured provider and test it
  for (const [name, cfg] of Object.entries(providers)) {
    if (!cfg) continue

    switch (name) {
      case 'anthropic': {
        const apiKey = (cfg.api_key as string | undefined) ?? process.env.ANTHROPIC_API_KEY ?? ''
        if (!apiKey) continue
        const model = (cfg.model as string | undefined) ?? 'claude-3-haiku-20240307'
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'Respond with exactly: OK' }],
          }),
          signal: AbortSignal.timeout(15_000),
        })
        if (resp.ok) {
          return { pass: true, message: `Provider ${name}: responded` }
        }
        const body = await resp.text()
        return { pass: false, message: `Provider ${name}: ${resp.status}`, detail: body }
      }

      case 'xai': {
        const apiKey = (cfg.api_key as string | undefined) ?? process.env.XAI_API_KEY ?? ''
        if (!apiKey) continue
        const model = (cfg.model as string | undefined) ?? 'grok-4-1-fast-reasoning'
        const resp = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 5,
            messages: [{ role: 'user', content: 'Respond with exactly: OK' }],
          }),
          signal: AbortSignal.timeout(15_000),
        })
        if (resp.ok) {
          return { pass: true, message: `Provider ${name}: responded` }
        }
        const body = await resp.text()
        return { pass: false, message: `Provider ${name}: ${resp.status}`, detail: body }
      }

      case 'ollama': {
        const baseUrl = (cfg.base_url as string | undefined) ?? 'http://localhost:11434'
        const model = (cfg.model as string | undefined) ?? 'qwen2.5:7b'
        const resp = await fetch(`${baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: 'Say OK', stream: false }),
          signal: AbortSignal.timeout(30_000),
        })
        if (resp.ok) {
          return { pass: true, message: `Provider ${name}: responded` }
        }
        return { pass: false, message: `Provider ${name}: ${resp.status}` }
      }

      default:
        continue
    }
  }

  return { pass: false, message: 'No provider configured or all missing API keys' }
}

async function testMemory(): Promise<{ pass: boolean; message: string; detail?: string }> {
  const pgUrl = process.env.RIVETOS_PG_URL
  if (!pgUrl) {
    return { pass: false, message: 'RIVETOS_PG_URL not set' }
  }

  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: pgUrl })
  await client.connect()
  const result = await client.query<{ ok: number }>('SELECT 1 AS ok')
  await client.end()

  if (result.rows[0]?.ok === 1) {
    return { pass: true, message: 'Memory backend: SELECT 1 succeeded' }
  }
  return { pass: false, message: 'Memory backend: unexpected response' }
}

async function testToolRegistry(): Promise<{ pass: boolean; message: string; detail?: string }> {
  // Verify core tool packages exist in the monorepo
  const toolDirs = [
    'plugins/tools/file',
    'plugins/tools/search',
    'plugins/tools/shell',
    'plugins/tools/web',
    'plugins/tools/interaction',
  ]

  const missing: string[] = []
  for (const dir of toolDirs) {
    try {
      await access(resolve(process.cwd(), dir))
    } catch {
      missing.push(dir)
    }
  }

  if (missing.length === 0) {
    return { pass: true, message: `Tool registry: ${toolDirs.length} core packages found` }
  }
  return {
    pass: false,
    message: `Tool registry: ${missing.length} missing`,
    detail: missing.join(', '),
  }
}

async function testHealthEndpoint(): Promise<{ pass: boolean; message: string; detail?: string }> {
  const port = parseInt(process.env.RIVETOS_HEALTH_PORT ?? '3100', 10)
  const resp = await fetch(`http://127.0.0.1:${port}/health/live`, {
    signal: AbortSignal.timeout(3000),
  })

  if (resp.ok) {
    return { pass: true, message: `Health endpoint: :${port}/health/live responded` }
  }
  return { pass: false, message: `Health endpoint: ${resp.status}` }
}

async function testSharedStorage(): Promise<{ pass: boolean; message: string; detail?: string }> {
  const sharedDir = '/rivet-shared'
  try {
    await access(sharedDir)
  } catch {
    return { pass: true, message: 'Shared storage: /rivet-shared/ not mounted (single-agent mode)' }
  }

  const testFile = resolve(sharedDir, '.smoke-test')
  await writeFile(testFile, `smoke-test-${Date.now()}`)
  const content = await readFile(testFile, 'utf-8')
  await unlink(testFile)

  if (content.startsWith('smoke-test-')) {
    return { pass: true, message: 'Shared storage: read/write OK' }
  }
  return { pass: false, message: 'Shared storage: write succeeded but read-back failed' }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`Usage: rivetos test [options]

Run a quick smoke test to verify the system works end-to-end.

Options:
  -q, --quick       Skip provider test (saves tokens)
  -v, --verbose     Show detailed output
  --json            Output results as JSON
  -h, --help        Show this help

Tests:
  config            Config loads and validates
  provider          Provider responds to a minimal prompt (~5 tokens)
  memory            Memory backend connects (SELECT 1)
  tools             Core tool packages exist
  health            Health endpoint responds
  shared            Shared storage read/write (if mounted)
`)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export default async function test(): Promise<void> {
  const opts = parseArgs()
  const results: TestResult[] = []

  if (!opts.json) {
    console.log('🔩 RivetOS Smoke Test\n')
  }

  // 1. Config
  const configResult = await runTest('config', testConfig)
  results.push(configResult)

  // 2. Provider (skip if --quick)
  if (opts.quick) {
    results.push(skip('provider', 'Skipped (--quick)'))
  } else {
    results.push(await runTest('provider', testProvider))
  }

  // 3. Memory
  results.push(await runTest('memory', testMemory))

  // 4. Tool registry
  results.push(await runTest('tools', testToolRegistry))

  // 5. Health endpoint
  results.push(await runTest('health', testHealthEndpoint))

  // 6. Shared storage
  results.push(await runTest('shared', testSharedStorage))

  // Output
  if (opts.json) {
    const summary = {
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      skip: results.filter((r) => r.status === 'skip').length,
      totalMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    }
    console.log(JSON.stringify({ tests: results, summary }, null, 2))
  } else {
    for (const r of results) {
      const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭️'
      const time = r.durationMs > 0 ? ` (${r.durationMs}ms)` : ''
      console.log(`${icon} ${r.name}: ${r.message}${time}`)
      if (opts.verbose && r.detail) {
        console.log(`   ${r.detail}`)
      }
    }

    const passed = results.filter((r) => r.status === 'pass').length
    const failed = results.filter((r) => r.status === 'fail').length
    const skipped = results.filter((r) => r.status === 'skip').length
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0)

    console.log('')
    if (failed === 0) {
      console.log(`✅ ${passed} passed${skipped ? `, ${skipped} skipped` : ''} (${totalMs}ms)`)
    } else {
      console.log(
        `❌ ${failed} failed, ${passed} passed${skipped ? `, ${skipped} skipped` : ''} (${totalMs}ms)`,
      )
    }
  }

  const failed = results.filter((r) => r.status === 'fail').length
  if (failed > 0) {
    process.exit(1)
  }
}
