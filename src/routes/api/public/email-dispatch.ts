/**
 * Hintergrundlauf für die E-Mail-Warteschlange: versendet fällige Sammelmails (Stufe 2)
 * und alle Eilmeldungen (Stufe 1), die beim Auslösen nicht zugestellt werden konnten.
 * Aufruf nur mit gültigem Cron-Schlüssel.
 */

import { createFileRoute } from '@tanstack/react-router'
import { authenticateCronRequest } from '@/integrations/supabase/cron-auth'
import { Db } from '@/bautakt/server/db'
import { flushDueEmails } from '@/bautakt/server/services/mailQueue'

export const Route = createFileRoute('/api/public/email-dispatch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request)
        if (denied) return denied
        const result = await flushDueEmails(new Db(), 200)
        return Response.json({ ok: true, ...result })
      },
    },
  },
})
