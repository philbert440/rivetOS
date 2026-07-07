import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // Workspace-linked CJS package: prebundle for named-export interop in
    // dev (the production rollup build handles CJS on its own).
    include: ['@rivetos/gateway-client'],
  },
  server: {
    // Dev-only: proxy gateway calls to a live node so `vite` against ct115
    // (or any node via RIVETHUB_DEV_GATEWAY) just works.
    proxy: {
      '/api': {
        target: process.env.RIVETHUB_DEV_GATEWAY ?? 'http://127.0.0.1:5174',
        ws: true,
      },
      '/healthz': {
        target: process.env.RIVETHUB_DEV_GATEWAY ?? 'http://127.0.0.1:5174',
      },
    },
  },
})
