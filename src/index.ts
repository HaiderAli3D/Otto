import Fastify from 'fastify'
import { config } from './config.js'
import { ensureSchema } from './db/client.js'
import { log } from './lib/log.js'
import { adminRoutes } from './routes/admin.js'
import { deviceRoutes } from './routes/device.js'
import { startScheduler } from './scheduler/loop.js'

async function main(): Promise<void> {
  ensureSchema()

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

  startScheduler()

  await app.listen({ port: config.port, host: '0.0.0.0' })
  log.info(
    {
      port: config.port,
      origin: config.publicOrigin,
      features: { whatsapp: Boolean(config.meta), agent: Boolean(config.anthropic), google: Boolean(config.google) },
    },
    'Otto server up',
  )
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error')
  process.exit(1)
})
