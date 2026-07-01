import { buildApp } from './app.js'
import { config } from './config.js'
import { ensureSchema } from './db/client.js'
import { log } from './lib/log.js'
import { startScheduler } from './scheduler/loop.js'

async function main(): Promise<void> {
  ensureSchema()

  if (!config.adminToken) {
    log.warn(
      'ADMIN_TOKEN is unset — /admin routes are OPEN (permitted on localhost only). Anyone who can reach this server can read pairing secrets.',
    )
  }

  const app = await buildApp()

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
