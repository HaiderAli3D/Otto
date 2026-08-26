import { and, desc, eq, like, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import { facts } from '../db/schema.js'
import { newFactId } from '../lib/ids.js'

export type Fact = typeof facts.$inferSelect

/**
 * How many facts get injected into the system prompt, and the character ceiling on the rendered
 * block. Beyond this the model uses `recall_facts`. ~30 short sentences is ≈450 tokens — cheap,
 * and it is what makes Otto *behave* like it knows the owner without being asked to look.
 */
export const INJECT_LIMIT = 30
export const INJECT_CHAR_BUDGET = 1_200

/** Total rows kept per device before the gc job starts pruning unused inferred facts. */
export const FACT_SOFT_CAP = 200

/**
 * Upsert by (deviceId, key). Writing an existing key REPLACES it — that is the point: "actually I
 * cycle now" must overwrite work.commute rather than leaving two contradictory rows behind.
 */
export function rememberFact(params: {
  deviceId: string
  key: string
  value: string
  category?: string
  pinned?: boolean
  confidence?: 'stated' | 'inferred'
}): Fact {
  const now = Date.now()
  const key = params.key.trim().toLowerCase()
  const existing = db
    .select()
    .from(facts)
    .where(and(eq(facts.deviceId, params.deviceId), eq(facts.key, key)))
    .get()

  if (existing) {
    const set = {
      value: params.value,
      category: params.category ?? existing.category,
      pinned: params.pinned ?? existing.pinned,
      confidence: params.confidence ?? existing.confidence,
      updatedAt: now,
    }
    db.update(facts).set(set).where(eq(facts.factId, existing.factId)).run()
    return { ...existing, ...set }
  }

  const row: Fact = {
    factId: newFactId(),
    deviceId: params.deviceId,
    key,
    value: params.value,
    category: params.category ?? 'general',
    pinned: params.pinned ?? false,
    confidence: params.confidence ?? 'stated',
    lastUsedAtMillis: now,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(facts).values(row).run()
  return row
}

export function forgetFact(deviceId: string, key: string): boolean {
  const res = db
    .delete(facts)
    .where(and(eq(facts.deviceId, deviceId), eq(facts.key, key.trim().toLowerCase())))
    .run()
  return res.changes > 0
}

/**
 * One fact's value by exact key, or null.
 *
 * `searchFacts` is a LIKE over key AND value, which is right for the model and wrong for code:
 * looking up `home.address` that way would also match a fact whose *value* mentions home. Server
 * logic that keys off a specific fact — the leave-by origin resolver, the travel-buffer fallback —
 * needs an exact read, and `rememberFact` lowercases every key on write, so this does too.
 */
export function factValue(deviceId: string, key: string): string | null {
  const row = db
    .select({ value: facts.value })
    .from(facts)
    .where(and(eq(facts.deviceId, deviceId), eq(facts.key, key.trim().toLowerCase())))
    .get()
  return row?.value ?? null
}

/** Free-text search across key and value, for the long tail beyond the injected set. */
export function searchFacts(deviceId: string, query: string | undefined): Fact[] {
  if (!query || !query.trim()) return listFacts(deviceId)
  const q = `%${query.trim().toLowerCase()}%`
  return db
    .select()
    .from(facts)
    .where(and(eq(facts.deviceId, deviceId), or(like(facts.key, q), like(facts.value, q))))
    .orderBy(desc(facts.pinned), desc(facts.lastUsedAtMillis))
    .all()
}

export function listFacts(deviceId: string): Fact[] {
  return db
    .select()
    .from(facts)
    .where(eq(facts.deviceId, deviceId))
    .orderBy(desc(facts.pinned), desc(facts.lastUsedAtMillis))
    .all()
}

/**
 * The facts block injected into the system prompt. Sorted deterministically (pinned first, then
 * key) so the rendered string is byte-stable between turns — an unstable ordering here would
 * invalidate the prompt cache on every request and quietly triple the running cost.
 *
 * Returns a stable sentence when empty, for the same reason.
 */
export function renderFacts(deviceId: string): string {
  const all = listFacts(deviceId)
  if (all.length === 0) {
    return "You don't know anything about the owner yet. Save facts with remember_fact as you learn them."
  }
  // Pick by pinned + recency, SPEND THE BUDGET IN THAT ORDER, and only then sort what survived by
  // key for a byte-stable render.
  //
  // The sort used to come first, so the budget was spent alphabetically and the `break` dropped
  // whatever sorted last — which has nothing to do with what matters. A pinned fact whose key began
  // with "w" lost to an inferred one beginning with "a", every turn, silently, and `listFacts` had
  // gone to the trouble of ordering by pinned and recency for nothing. The owner's stated wake time
  // is exactly the kind of thing that sorts late.
  const chosen: typeof all = []
  let budget = INJECT_CHAR_BUDGET
  for (const f of all.slice(0, INJECT_LIMIT)) {
    const line = `- ${f.key}: ${f.value}`
    // `continue`, not `break`: one long fact must not evict every shorter one behind it, and the
    // order here is importance, so the ones behind it are the ones we most want to keep.
    if (line.length > budget) continue
    budget -= line.length
    chosen.push(f)
  }
  const lines = chosen
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((f) => `- ${f.key}: ${f.value}`)
  const more = all.length > lines.length ? `\n(${all.length - lines.length} more — use recall_facts.)` : ''
  return `What you remember about the owner:\n${lines.join('\n')}${more}`
}

/** Touch recency for the facts the model actually looked at, so the LRU injection stays relevant. */
export function markFactsUsed(factIds: string[]): void {
  if (factIds.length === 0) return
  const now = Date.now()
  for (const id of factIds) {
    db.update(facts).set({ lastUsedAtMillis: now }).where(eq(facts.factId, id)).run()
  }
}
