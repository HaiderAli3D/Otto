import { beforeEach, describe, expect, it } from 'vitest'
import { ensureSchema } from '../src/db/client.js'
import {
  appendAssistantTurns,
  IDLE_RESET_MS,
  loadSession,
  maybeResetIdleSession,
  saveSession,
} from '../src/services/sessions.js'

beforeEach(() => ensureSchema())

const hours = (n: number): number => n * 60 * 60 * 1000

describe('idle session reset', () => {
  it('does nothing when there is no session yet', () => {
    expect(maybeResetIdleSession('wa_none')).toBe(false)
  })

  it('keeps a recent conversation intact', () => {
    saveSession('wa_recent', 'dev_1', [{ role: 'user', content: 'hello' }])
    expect(maybeResetIdleSession('wa_recent', Date.now() + hours(1))).toBe(false)
    expect(loadSession('wa_recent')).toHaveLength(1)
  })

  it('keeps a conversation that spans a working day', () => {
    saveSession('wa_day', 'dev_1', [{ role: 'user', content: 'morning' }])
    expect(maybeResetIdleSession('wa_day', Date.now() + hours(7))).toBe(false)
    expect(loadSession('wa_day')).toHaveLength(1)
  })

  it('clears the transcript after a long silence', () => {
    saveSession('wa_stale', 'dev_1', [
      { role: 'user', content: 'set an alarm' },
      { role: 'assistant', content: 'done' },
    ])
    expect(maybeResetIdleSession('wa_stale', Date.now() + IDLE_RESET_MS + 1000)).toBe(true)
    expect(loadSession('wa_stale')).toHaveLength(0)
  })

  it('is idempotent — an already-empty session is not "reset" again', () => {
    saveSession('wa_empty', 'dev_1', [])
    expect(maybeResetIdleSession('wa_empty', Date.now() + hours(48))).toBe(false)
  })

  it('a nudge delivered into an ongoing conversation is recorded', () => {
    saveSession('wa_live', 'dev_1', [{ role: 'user', content: 'hi' }])
    appendAssistantTurns('wa_live', 'dev_1', ['Still need the bins out?'])
    const after = loadSession('wa_live')
    expect(after).toHaveLength(2)
    expect(after[1]!.content).toBe('Still need the bins out?')
  })

  it('a nudge delivered into a freshly reset session is NOT persisted as a leading turn', () => {
    // A conversation may not begin with an assistant turn — trimToValidStart would drop it on
    // save, so persisting would be a silent no-op that merely looked like it worked. Resolving a
    // bare "done" relies on the open-reminder list injected into the system prompt instead.
    saveSession('wa_reset', 'dev_1', [{ role: 'user', content: 'old chatter' }])
    expect(maybeResetIdleSession('wa_reset', Date.now() + hours(24))).toBe(true)

    appendAssistantTurns('wa_reset', 'dev_1', ['Still need the bins out?'])
    expect(loadSession('wa_reset')).toHaveLength(0)
  })
})
