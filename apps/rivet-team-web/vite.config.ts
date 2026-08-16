import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Stack versions match apps/rivethub-web (React 19 / Vite 8 / Tailwind 4).
// Dev proxy is the same gateway origin Hub uses (den-server default :5174).
export default defineConfig({
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
