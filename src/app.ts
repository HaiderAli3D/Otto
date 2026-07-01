import Fastify from 'fastify'
import { config } from './config.js'
import { log } from './lib/log.js'
import { adminRoutes } from './routes/admin.js'
import { deviceRoutes } from './routes/device.js'

/**
 * Build the HTTP app (parser + routes). Extracted from index.ts so tests can exercise the real
 * route stack via fastify.inject without booting the scheduler or binding a port. The return
 * type is inferred: the pino loggerInstance specializes Fastify's instance generics.
 */
export async function buildApp() {
  const app = Fastify({ loggerInstance: log, bodyLimit: 1_048_576 })

  // Preserve the raw JSON body so the WhatsApp webhook can verify Meta's X-Hub-Signature-256
  // (which is computed over the exact bytes Meta sent, not a re-serialization).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    ;(req as unknown as { rawBody?: Buffer }).rawBody = body as Buffer
    if ((body as Buffer).length === 0) return done(null, undefined)
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')))
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  await app.register(deviceRoutes)
  await app.register(adminRoutes)

  // WhatsApp webhook + Google OAuth routes register only when their integration is configured.
  if (config.meta) {
    const { whatsappRoutes } = await import('./routes/whatsapp.js')
    await app.register(whatsappRoutes)
  }
  if (config.google) {
    const { oauthRoutes } = await import('./routes/oauth.js')
    await app.register(oauthRoutes)
  }

  app.get('/health', async () => ({ ok: true, ts: Date.now() }))

  return app
}
