import { beforeEach, describe, expect, it } from 'vitest'
import { ensureSchema } from '../src/db/client.js'
import { forgetFact, listFacts, rememberFact, renderFacts, searchFacts } from '../src/services/facts.js'

beforeEach(() => ensureSchema())

describe('facts', () => {
  it('stores a fact and renders it into the prompt block', () => {
    rememberFact({ deviceId: 'dev_f1', key: 'work.commute', value: 'Cycles to work, about 25 minutes.' })
    const rendered = renderFacts('dev_f1')
    expect(rendered).toContain('work.commute')
    expect(rendered).toContain('Cycles to work')
  })

  it('OVERWRITES on the same key rather than accumulating contradictions', () => {
    rememberFact({ deviceId: 'dev_f2', key: 'work.commute', value: 'Drives to work.' })
    rememberFact({ deviceId: 'dev_f2', key: 'work.commute', value: 'Cycles to work now.' })
    const all = listFacts('dev_f2')
    expect(all).toHaveLength(1)
    expect(all[0]!.value).toBe('Cycles to work now.')
  })

  it('normalises key case so "Work.Commute" is the same fact', () => {
    rememberFact({ deviceId: 'dev_f3', key: 'Work.Commute', value: 'a' })
    rememberFact({ deviceId: 'dev_f3', key: 'work.commute', value: 'b' })
    expect(listFacts('dev_f3')).toHaveLength(1)
  })

  it('keeps facts separate per device', () => {
    rememberFact({ deviceId: 'dev_f4a', key: 'k', value: 'one' })
    rememberFact({ deviceId: 'dev_f4b', key: 'k', value: 'two' })
    expect(listFacts('dev_f4a')).toHaveLength(1)
    expect(listFacts('dev_f4b')[0]!.value).toBe('two')
  })

  it('searches across key and value', () => {
    rememberFact({ deviceId: 'dev_f5', key: 'health.gym_days', value: 'Goes to the gym Mon/Wed/Fri.' })
    rememberFact({ deviceId: 'dev_f5', key: 'people.sam', value: 'Sam is their partner.' })
    expect(searchFacts('dev_f5', 'gym')).toHaveLength(1)
    expect(searchFacts('dev_f5', 'partner')).toHaveLength(1)
    expect(searchFacts('dev_f5', undefined)).toHaveLength(2)
  })

  it('forgets a fact by key', () => {
    rememberFact({ deviceId: 'dev_f6', key: 'k', value: 'v' })
    expect(forgetFact('dev_f6', 'k')).toBe(true)
    expect(listFacts('dev_f6')).toHaveLength(0)
  })

  it('renders a stable empty state, so an empty memory does not churn the prompt cache', () => {
    const a = renderFacts('dev_f7_empty')
    const b = renderFacts('dev_f7_empty')
    expect(a).toBe(b)
    expect(a).toContain("don't know anything about the owner yet")
  })

  it('renders deterministically regardless of insertion order', () => {
    rememberFact({ deviceId: 'dev_f8', key: 'zebra', value: 'z' })
    rememberFact({ deviceId: 'dev_f8', key: 'alpha', value: 'a' })
    const first = renderFacts('dev_f8')
    // Touch recency in the opposite order; the rendered block must not change, or every turn
    // invalidates the cached system prefix.
    rememberFact({ deviceId: 'dev_f8', key: 'zebra', value: 'z' })
    expect(renderFacts('dev_f8')).toBe(first)
  })
})
