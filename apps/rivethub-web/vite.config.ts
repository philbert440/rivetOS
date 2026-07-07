import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
