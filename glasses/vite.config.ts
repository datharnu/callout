import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths, so the packaged .ehpk works wherever the host serves it from.
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
