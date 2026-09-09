import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The page renders every time in the viewer's own zone, so the tests need a
// known "viewer" — otherwise the expected clock times move with the machine.
process.env.TZ = 'Asia/Jerusalem'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    css: true,
    env: { TZ: 'Asia/Jerusalem' },
  },
})