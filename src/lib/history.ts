import type Anthropic from '@anthropic-ai/sdk'

export type Msg = Anthropic.MessageParam

/**
 * Keep the recent conversation only — enough for coherent threads without unbounded growth.
 *
 * Counted in *messages*, not turns: each tool step appends 2 (assistant tool_use + user
 * tool_result), so a 10-step turn eats 20 on its own. 60 leaves room for a tool-heavy turn without
 * evaporating the previous one. Prompt caching keeps the cost of the wider window near zero.
 */
export const MAX_MESSAGES = 60

/**
 * Trim history to the most recent turns, then advance the start to the first plain-text user turn.
 * A valid Anthropic conversation must begin with a user turn whose content is a string (NOT a
 * `tool_result` continuation whose paired `tool_use` was just trimmed away, and not an assistant
 * turn). Returning a normalized array keeps a long, tool-heavy conversation from ever persisting an
 * invalid leading shape that the API would reject on the next call. Pure (no DB) so it is unit-tested.
 */
export function trimToValidStart(messages: Msg[], max: number = MAX_MESSAGES): Msg[] {
  const trimmed = messages.slice(-max)
  let start = 0
  while (start < trimmed.length) {
    const m = trimmed[start]
    if (m && m.role === 'user' && typeof m.content === 'string') break
    start++
  }
  return trimmed.slice(start)
}
