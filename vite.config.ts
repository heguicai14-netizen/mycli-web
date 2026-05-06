import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json' with { type: 'json' }
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@ext': path.resolve(__dirname, 'src/extension'),
      '@core': path.resolve(__dirname, 'src/agent-core'),
      '@ext-tools': path.resolve(__dirname, 'src/extension-tools'),
    },
  },
  plugins: [
    react(),
    crx({ manifest }),
  ],
  build: {
    target: 'chrome114',
    minify: false,
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      // offscreen.html is loaded via chrome.offscreen.createDocument — not referenced
      // from the manifest, so @crxjs won't pick it up automatically. Add it as an
      // explicit input so Vite bundles offscreen.ts and emits the HTML.
      input: {
        offscreen: path.resolve(__dirname, 'html/offscreen.html'),
      },
    },
  },
})
