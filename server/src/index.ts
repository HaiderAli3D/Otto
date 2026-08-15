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
      features: {
        whatsapp: Boolean(config.meta),
        agent: Boolean(config.openai),
        google: Boolean(config.google),
        voice: Boolean(config.stt),
        template: Boolean(config.meta?.template),
        maps: Boolean(config.maps),
      },
      // Logged because a typo'd OPENAI_MODEL is otherwise invisible: it 404s on the first request,
      // and every surface fails soft to a template, so a wrong model looks like a quiet Otto
      // rather than an error. Not a secret, and constant for the process's life.
      model: config.openai?.model ?? null,
    },
    'Otto server up',
  )

  // Graceful shutdown: on a deploy/restart, stop accepting new work and let in-flight requests
  // (an agent turn arming an alarm) finish before the process exits, so we don't drop a reply or
  // an arm mid-flight. fly.toml sends SIGINT with a kill_timeout grace period.
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return
      closing = true
      log.info({ signal }, 'Shutting down…')
      app.close().then(
        () => process.exit(0),
        (err) => {
          log.error({ err }, 'error during shutdown')
          process.exit(1)
        },
      )
    })
  }
}

main().catch((err) => {
  log.error({ err }, 'fatal startup error')
  process.exit(1)
})
