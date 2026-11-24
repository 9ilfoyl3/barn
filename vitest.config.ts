import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/tests/**/*.test.ts',
      'tests/**/*.test.ts',
      'scripts/**/*.test.ts',
    ],
  },
})
