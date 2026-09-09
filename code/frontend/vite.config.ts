import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true, // Allow external connections (important for Docker)
    proxy: {
      // Dev-server forwarding, mirrors what nginx does in the built image.
      // BACKEND_URL points at the backend; the browser only ever calls /api.
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'build',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          mui: ['@mui/material', '@emotion/react', '@emotion/styled'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  preview: {
    port: 3000,
    host: true,
  },
  define: {
    // Replace process.env with import.meta.env for Vite
    'process.env': {},
  },
})