import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@ext': path.resolve(__dirname, 'src/extension'),
      '@ext-tools': path.resolve(__dirname, 'src/extension-tools'),
      '@ext-skills': path.resolve(__dirname, 'src/extension-skills'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
