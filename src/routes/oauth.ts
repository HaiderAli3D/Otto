import type { FastifyInstance } from 'fastify'
import { log } from '../lib/log.js'
import { exchangeCode, googleAuthUrl } from '../services/google.js'

/**
 * OAuth handshake for linking a device's Google account. The owner opens `/start?deviceId=...`,
 * consents at Google, and Google redirects back to `/callback` with the code + our state.
 */
export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oauth/google/start', async (req, reply) => {
    const { deviceId } = req.query as { deviceId?: string }
    if (!deviceId) {
      return reply.code(400).send('Missing deviceId')
    }
    return reply.redirect(googleAuthUrl(deviceId))
  })

  app.get('/oauth/google/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string }
    if (!code || !state) {
      return reply.code(400).send('Missing code or state')
    }
    try {
      await exchangeCode(state, code)
      return reply
        .type('text/html')
        .send('<h2>Google connected ✔</h2><p>You can close this tab.</p>')
    } catch (err) {
      log.error({ err }, 'google oauth callback failed')
      return reply.code(500).send('Google connection failed. Please try again.')
    }
  })
}
