import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Build stamp shown in Settings — the desktop shell bakes this dist in at
// build time, so "which dist am I running?" must be answerable from the UI
// (the binary otherwise goes stale invisibly).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}
let sha = 'unknown'
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim()
} catch {
  /* not a git checkout (tarball build) — stamp stays 'unknown' */
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_INFO__: JSON.stringify({
      version: pkg.version,
      sha,
      builtAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z',
    }),
  },
  optimizeDeps: {
    // Workspace-linked CJS packages: prebundle for named-export interop in
    // dev (the production rollup build handles CJS on its own). @rivetos/types
    // is CJS with defineProperty re-exports (e.g. parseSessionId) that Vite's
    // on-the-fly interop can't see when the package is served raw from source.
    include: ['@rivetos/gateway-client', '@rivetos/types'],
  },
  server: {
    // Dev-only: proxy gateway calls to a live node so `vite` against ct115
    // (or any node via RIVETHUB_DEV_GATEWAY) just works.
    proxy: {
      '/api': {
        target: process.env.RIVETHUB_DEV_GATEWAY ?? 'http://127.0.0.1:5174',
        ws: true,
        // A live node serves TLS with a self-signed CA cert; don't reject it.
        secure: false,
      },
      '/healthz': {
        target: process.env.RIVETHUB_DEV_GATEWAY ?? 'http://127.0.0.1:5174',
        secure: false,
      },
    },
  },
})
