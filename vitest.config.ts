import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-env.ts'],
    /**
     * Well above vitest's 5s default, and it is about COLD runs rather than slow tests.
     *
     * The four suites that build a real Fastify app (`routes.smoke`, `device-routes`, `device-auth`,
     * `wakeCheck`) each finish in about 1.4 seconds once the TypeScript transform cache is warm. On
     * a fresh clone or after `node_modules` changes, collection alone takes ~190s across the suite,
     * and `buildApp()` lands inside a worker still competing for that — so all four blew the 5s
     * budget and failed, on a suite that is entirely green a second later.
     *
     * A timeout that only holds on the second run is not a timeout, it is a coin flip that says
     * "your merge broke four things" to whoever runs the tests first.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
