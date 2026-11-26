import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Two static pages served by the backend from one origin: / (landing) and /try/ (browser G2 preview).
// In dev, /api and /glasses are proxied so the preview iframe stays same-origin (postMessage contract).
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: decodeURI(new URL('./index.html', import.meta.url).pathname),
        try: decodeURI(new URL('./try/index.html', import.meta.url).pathname),
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/glasses': { target: 'http://127.0.0.1:5182', rewrite: p => p },
    },
  },
})
