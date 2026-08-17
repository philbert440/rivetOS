import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Stack versions match apps/rivethub-web (React 19 / Vite 8 / Tailwind 4).
// Dev proxy is the same gateway origin Hub uses (den-server default :5174).
// Loopback den is operator, so this proxy lets any :5180 browser mint users.
// base './' so the Android WebView can load the built SPA from assets.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5180,
    proxy: {
      '/api': {
        target: process.env.RIVETTEAM_DEV_GATEWAY ?? 'http://127.0.0.1:5174',
        ws: true,
      },
      '/healthz': {
        target: process.env.RIVETTEAM_DEV_GATEWAY ?? 'http://127.0.0.1:5174',
      },
    },
  },
})
