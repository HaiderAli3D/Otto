import { describe, expect, it } from 'vitest'
import { makeApp } from './helpers.js'

describe('route smoke', () => {
  it('health responds ok', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })

  it('unknown device alarms fetch is a 404, never an empty 200', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/devices/dev_missing/alarms' })
    expect(res.statusCode).toBe(404)
  })

  it('token registration returns 204 and the armed set starts empty', async () => {
    const app = await makeApp()
    const reg = await app.inject({
      method: 'POST',
      url: '/devices/dev_smoke/token',
      payload: { token: 't1', appVersion: '1.0.0' },
    })
    expect(reg.statusCode).toBe(204)
    const alarms = await app.inject({ method: 'GET', url: '/devices/dev_smoke/alarms' })
    expect(alarms.statusCode).toBe(200)
    expect(alarms.json()).toEqual({ alarms: [] })
  })

  it('admin routes reject a missing admin token', async () => {
    const app = await makeApp()
    const res = await app.inject({ method: 'GET', url: '/admin/devices' })
    expect(res.statusCode).toBe(401)
  })
})
