import { createFileRoute } from '@tanstack/react-router'
import { getApiApp } from '@/bautakt/server/index'

async function handle({ request }: { request: Request }) {
  try {
    const app = await getApiApp()
    return await app.fetch(request)
  } catch (err) {
    console.error('[api] Fehler beim Verarbeiten der Anfrage', err)
    return new Response(JSON.stringify({ error: 'Interner Fehler: ' + (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
      OPTIONS: handle,
    },
  },
})
