/**
 * Test environment. Runs before each test file's imports — config.ts parses env at import time,
 * so these must be set here, not inside tests. Each test file gets its own worker and therefore
 * its own private in-memory database.
 */
process.env.DATABASE_PATH = ':memory:'
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'test-project',
  client_email: 'test@test.invalid',
  private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
})
process.env.ADMIN_TOKEN = 'test-admin-token'
process.env.LOG_LEVEL = 'silent'
process.env.PUBLIC_ORIGIN = 'http://localhost:3000'
// WhatsApp configured so config.meta is non-null (sendText/webhook logic is testable). Tests
// stub global fetch — these dummy values are never sent anywhere.
process.env.META_APP_SECRET = 'test-app-secret'
process.env.META_VERIFY_TOKEN = 'test-verify-token'
process.env.META_WA_PHONE_NUMBER_ID = '15550000000'
process.env.META_WA_ACCESS_TOKEN = 'test-wa-access-token'
