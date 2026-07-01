import { describe, expect, it } from 'vitest'
import { adminTokenRequired } from '../src/config.js'

describe('adminTokenRequired', () => {
  it('requires a token on a public origin', () => {
    expect(adminTokenRequired('https://otto.fly.dev', null)).toBe(true)
  })

  it('allows open admin on localhost origins', () => {
    expect(adminTokenRequired('http://localhost:3000', null)).toBe(false)
    expect(adminTokenRequired('http://127.0.0.1:3000', null)).toBe(false)
  })

  it('is satisfied by a token on any origin', () => {
    expect(adminTokenRequired('https://otto.fly.dev', 'tok')).toBe(false)
    expect(adminTokenRequired('http://localhost:3000', 'tok')).toBe(false)
  })

  it('fails closed on an unparseable origin', () => {
    expect(adminTokenRequired('not a url', null)).toBe(true)
  })
})
