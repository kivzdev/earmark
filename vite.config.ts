import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// `npm run dev`: the dashboard with hot reload, talking to the helper (`earmark`, port 3276) for its data — or, with
// EARMARK_API=http://127.0.0.1:3277, to the cloud copy's API running locally (server/dev.ts).
// `npm run build`: dist/, which the helper serves at http://127.0.0.1:3276 and Vercel serves for the cloud copy.
const api = process.env.EARMARK_API || 'http://127.0.0.1:3276'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5191,
    strictPort: true,
    proxy: {
      // the helper only answers requests addressed to it, so the Host header goes along as 127.0.0.1:3276
      '/api': { target: api, changeOrigin: true },
      '/media': { target: api, changeOrigin: true },
    },
  },
})
