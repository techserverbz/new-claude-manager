import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite already serves index.html for unknown routes by default in dev mode (SPA fallback).
// We just add an /api proxy so the React app can call our file server on :4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5111,
    open: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4111',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:4111',
        ws: true,
      },
    },
  },
})
