#!/usr/bin/env node
/**
 * Bundle the Claude Code capture hooks into a single self-contained `.mjs`
 * (pg inlined) — the artifact deployed as `rivet-memory-hooks.mjs` on the phone
 * (/opt/rivet-memory/bin) and in /rivet-shared/rivet-phone/memory-plugin.
 *
 * This step previously existed only as tribal knowledge (no checked-in config);
 * it is now reproducible. Entry is hooks.ts (the CLI dispatcher). The on-device
 * agent identity is selected at runtime via RIVETOS_CAPTURE_AGENT (see
 * transcript-capture.ts CAPTURE_AGENT), so the same bundle serves rivet-claude
 * and rivet-phone-claude.
 *
 *   node scripts/bundle-rivet-memory.mjs [outfile]
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'url'
import path from 'path'

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = process.argv[2] || path.join(pkgDir, 'bin', 'rivet-memory-hooks.mjs')

// esbuild hoists the entry file's own shebang (hooks.ts) to the top, so the
// banner is just the ESM require/__dirname shim.
const banner = {
  js:
    "import { createRequire } from 'module'; import { fileURLToPath as __f } from 'url'; " +
    "import { dirname as __d } from 'path'; const require = createRequire(import.meta.url); " +
    'const __filename = __f(import.meta.url); const __dirname = __d(__filename);',
}

await build({
  entryPoints: [path.join(pkgDir, 'src', 'hooks.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner,
  outfile: out,
  logLevel: 'info',
})
console.log('bundled ->', out)
