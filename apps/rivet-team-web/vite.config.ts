import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/omb', import.meta.url)),
    },
  },
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
