// The cloud copy's API on your own computer, files in a folder instead of Vercel Blob:
//   EARMARK_CLOUD_DIR=./.cloud SESSION_SECRET=… EARMARK_SETUP_CODE=… EARMARK_SYNC_TOKEN=… npx tsx server/dev.ts
// then `EARMARK_API=http://127.0.0.1:3277 npm run dev` serves the dashboard against it at http://localhost:5191.
import { serve } from '@hono/node-server'
import { app } from './cloud.js'

const port = Number(process.env.PORT || 3277)
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => console.log(`Earmark cloud API on http://127.0.0.1:${port}`))
