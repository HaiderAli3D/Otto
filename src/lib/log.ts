import { pino } from 'pino'
import { config } from '../config.js'

/**
 * Structured logger with secret redaction (mirrors the Android app's OttoLog.redact):
 * tokens, secrets, and signatures never hit the logs.
 */
export const log = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'token',
      '*.token',
      'accessToken',
      '*.accessToken',
      'secret',
      '*.secret',
      'hmacSecret',
      '*.hmacSecret',
      'sig',
      '*.sig',
      // Latent today — nothing logs the config object. Listed anyway because a provider migration
      // is exactly the moment somebody adds `log.info({ config }, 'boot')` to debug a bad key.
      'apiKey',
      '*.apiKey',
      'api_key',
      '*.api_key',
      'req.headers.authorization',
      'req.headers["x-hub-signature-256"]',
      'req.headers["x-otto-sig"]',
      'req.headers["x-admin-token"]',
    ],
    censor: '[redacted]',
  },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
})
