import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { Agent } from 'node:https'
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

// Dev gateway target, resolved once so both proxy entries below cannot drift.
const gateway = process.env.RIVETHUB_DEV_GATEWAY ?? 'http://127.0.0.1:5174'

// TLS to the dev gateway is verified by default. RIVETHUB_DEV_CA may point at a
// PEM CA bundle to trust a node certificate; it rides the proxy's outbound
// `agent`, so Node still verifies the chain. A node that additionally requires
// a client certificate is out of scope — this dev proxy presents none.
// RIVETHUB_DEV_INSECURE_TLS=1 is the explicit opt-out, never a fallback.
const insecureTls = process.env.RIVETHUB_DEV_INSECURE_TLS === '1'
if (insecureTls) {
  console.warn(
    'RIVETHUB_DEV_INSECURE_TLS=1: TLS certificate verification is disabled for the RivetHub dev proxy.',
  )
}

const caPath = process.env.RIVETHUB_DEV_CA
let ca: Buffer | undefined
if (caPath) {
  try {
    ca = readFileSync(caPath)
  } catch (err) {
    throw new Error(
      `RIVETHUB_DEV_CA is set to "${caPath}" but the CA file could not be read: ${(err as Error).message}`,
    )
  }
}
const caAgent = ca ? new Agent({ ca }) : undefined

// Vite forwards `server.proxy` options to http-proxy: `ssl` configures the
// proxy's own HTTPS server and `secure` is only a boolean, so a custom CA
// belongs on the outbound `agent` — which keeps verification on.
function devProxy(extra: { ws?: boolean } = {}) {
  return {
    target: gateway,
    ...extra,
    ...(insecureTls ? { secure: false } : {}),
    ...(caAgent ? { agent: caAgent } : {}),
  }
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
    // is a linked workspace package whose `exports` point at built CJS `dist`,
    // which Vite does not pre-bundle unless it is listed here — leaving its
    // defineProperty re-exports (e.g. parseSessionId) invisible to dev.
    include: ['@rivetos/gateway-client', '@rivetos/types'],
  },
  server: {
    // Dev-only: proxy gateway calls to a live node so `vite` against a node (
    // whichever RIVETHUB_DEV_GATEWAY names) works without CORS. Reaching a node
    // that serves TLS still depends on trust via RIVETHUB_DEV_CA, and a node
    // that requires a client certificate cannot be reached through this proxy.
    proxy: {
      '/api': devProxy({ ws: true }),
      '/healthz': devProxy(),
    },
  },
})
