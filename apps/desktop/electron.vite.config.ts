import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Main and preload bundle all their dependencies (workspace packages ship TypeScript sources), so
// the packaged app needs no node_modules.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      // ws's optional native helpers: left unresolved, its require() fails and ws uses its JS code
      // (bundled, Vite would stub them with an empty object and ws would call undefined).
      rollupOptions: { external: ['bufferutil', 'utf-8-validate'] },
    },
  },
  preload: {
    build: { externalizeDeps: false },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src') } },
    // noVNC uses top-level await; Electron's Chromium supports it natively.
    build: {
      target: 'esnext',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
    optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  },
})
