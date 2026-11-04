// The cloud copy's API as one Vercel function; vercel.json sends every /api/* request here.
import { handle } from 'hono/vercel'
import { app } from '../server/cloud.js'

const h = handle(app)
export const GET = h, POST = h, PUT = h, PATCH = h, DELETE = h
