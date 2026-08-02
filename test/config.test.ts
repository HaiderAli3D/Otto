import { describe, expect, it } from 'vitest'
import { adminTokenRequired, config, parseWeeklyReview } from '../src/config.js'

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

describe('optional integrations default to OFF', () => {
  // The precondition every feature branch inherits: test/setup-env.ts pins only what the server
  // needs to boot, so anything gated must read as null here. If one of these ever goes non-null,
  // a suite has started hitting a real third party — the same guarantee persona.test.ts asserts
  // about config.anthropic, extended to the three integrations Phase 0 introduced.
  it('has no speech-to-text configured', () => {
    expect(config.stt).toBeNull()
  })

  it('has no maps key configured', () => {
    expect(config.maps).toBeNull()
  })

  it('has WhatsApp configured but no approved template', () => {
    // The nesting is the point: template lives INSIDE meta, so "template without WhatsApp" cannot
    // be represented at all.
    expect(config.meta).not.toBeNull()
    expect(config.meta?.template).toBeNull()
  })

  it('carries the documented scheduling defaults', () => {
    expect(config.quietHoursDefault).toBe('22:00-07:00')
    expect(config.weeklyReviewDefault).toBe('SUN:18:00')
  })
})

describe('parseWeeklyReview', () => {
  it('parses a slot to a luxon weekday (1 = Monday … 7 = Sunday)', () => {
    expect(parseWeeklyReview('SUN:18:00')).toEqual({ weekday: 7, hour: 18, minute: 0 })
    expect(parseWeeklyReview('MON:09:30')).toEqual({ weekday: 1, hour: 9, minute: 30 })
    expect(parseWeeklyReview(' fri:7:05 ')).toEqual({ weekday: 5, hour: 7, minute: 5 })
  })

  it('reads "off" and an empty value as no review', () => {
    expect(parseWeeklyReview('off')).toBeNull()
    expect(parseWeeklyReview('')).toBeNull()
    expect(parseWeeklyReview(null)).toBeNull()
  })

  it('never throws on garbage — it degrades to no review', () => {
    // Same 3am contract as parseQuietHours: this value reaches the scheduler, so a bad one must not
    // take down the job that read it. Boot validation is what stops a typo getting this far.
    expect(parseWeeklyReview('SUNDAY:18:00')).toBeNull()
    expect(parseWeeklyReview('SUN:25:00')).toBeNull()
    expect(parseWeeklyReview('SUN:18:99')).toBeNull()
    expect(parseWeeklyReview('18:00')).toBeNull()
    expect(parseWeeklyReview('XXX:18:00')).toBeNull()
  })
})
