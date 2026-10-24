import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // The manager daemon (bun manager/daemon.ts) owns the actual API;
      // this just lets `bun run dev` talk to it without CORS setup.
      '/api': `http://localhost:${process.env.MANAGER_PORT ?? 7790}`,
    },
  },
})
