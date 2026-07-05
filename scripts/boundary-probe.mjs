#!/usr/bin/env node
/**
 * Smoke-test the @nx/enforce-module-boundaries walls (both axes).
 *
 * Writes throwaway probe files that SHOULD violate (or satisfy) the
 * boundary rules, lints them, and fails if the rule doesn't behave as
 * documented. Keeps the guarantees in the PR bodies from rotting.
 *
 * Run: npm run lint:boundaries
 */
import { execFileSync } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'

const probes = [
  {
    name: 'domain axis: telegram (runtime) → memory-postgres must FAIL',
    project: '@rivetos/channel-telegram',
    file: 'plugins/channels/telegram/src/boundary-probe.ts',
    code: "import type { PostgresMemoryConfig } from '@rivetos/memory-postgres'\nexport type _P = PostgresMemoryConfig\n",
    expectViolation: true,
  },
  {
    name: 'allow escape hatch: mcp-server → memory-postgres must PASS',
    project: '@rivetos/mcp-server',
    file: 'plugins/transports/mcp-server/src/boundary-probe.ts',
    code: "import type { PostgresMemoryConfig } from '@rivetos/memory-postgres'\nexport type _P = PostgresMemoryConfig\n",
    expectViolation: false,
  },
  {
    name: 'scope axis survives the mcp-server override: mcp-server (scope:transport) → nx-plugin (scope:tooling) must FAIL',
    project: '@rivetos/mcp-server',
    file: 'plugins/transports/mcp-server/src/boundary-probe.ts',
    code: "import type {} from '@rivetos/nx'\nexport const _p = 1\n",
    expectViolation: true,
  },
]

let failed = 0
for (const probe of probes) {
  writeFileSync(probe.file, probe.code)
  let violated = false
  try {
    // Lint through nx (like CI) — the boundary rule needs the project graph,
    // which a bare `eslint <file>` invocation does not reliably provide.
    execFileSync('npx', ['nx', 'lint', probe.project, '--skip-nx-cache'], { stdio: 'pipe' })
  } catch (err) {
    const out = `${err.stdout}${err.stderr}`
    if (!out.includes('@nx/enforce-module-boundaries')) {
      console.error(`✗ ${probe.name} — lint failed for an unrelated reason:\n${out}`)
      failed++
      unlinkSync(probe.file)
      continue
    }
    violated = true
  } finally {
    try {
      unlinkSync(probe.file)
    } catch {
      /* already removed */
    }
  }
  if (violated === probe.expectViolation) {
    console.log(`✓ ${probe.name}`)
  } else {
    console.error(`✗ ${probe.name} — expected ${probe.expectViolation ? 'a violation' : 'a pass'}, got ${violated ? 'a violation' : 'a pass'}`)
    failed++
  }
}

process.exit(failed === 0 ? 0 : 1)
