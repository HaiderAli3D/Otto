import OpenAI, { APIConnectionError } from 'openai'
import { config } from '../config.js'
import { log } from '../lib/log.js'

/**
 * The narrow slice of the OpenAI SDK Otto actually uses.
 *
 * Declaring it as an interface rather than passing the SDK client around is what makes every model
 * surface testable. Nothing else from the SDK is reachable from the rest of the codebase.
 */
export interface ModelClient {
  create(
    params: OpenAI.Responses.ResponseCreateParamsNonStreaming,
    options?: { timeout?: number; maxRetries?: number },
  ): Promise<OpenAI.Responses.Response>
}

const cfg = config.openai

/**
 * The ONE client, built once. This replaces five identical `new Anthropic(...)` calls that sat at
 * module scope in runner.ts, brief.ts, nudge.ts, compose.ts and review.ts.
 */
const real: ModelClient | null = cfg
  ? (() => {
      const sdk = new OpenAI({ apiKey: cfg.apiKey })
      return { create: (params, options) => sdk.responses.create(params, options) }
    })()
  : null

let override: ModelClient | null = null

/**
 * Resolved at CALL time, never captured at import.
 *
 * That distinction is the whole reason the model path is testable now. The previous design captured
 * the client at import from `config`, and `config` is parsed at import from `process.env` — so
 * under vitest the key was absent, the client was null, and every test silently exercised the
 * templated fallback instead of the thing it claimed to test.
 *
 * null still means "the feature gate is closed": no OPENAI_API_KEY, so every caller degrades to its
 * deterministic template exactly as before.
 */
export function modelClient(): ModelClient | null {
  return override ?? real
}

/**
 * Resolved once, so callers never reach into `config.openai` themselves. One null gate, not two.
 */
export const MODEL = cfg?.model ?? 'gpt-5.6-luna'

/** TEST ONLY. Throws outside vitest so it can never become a production backdoor. */
export function __setModelClient(client: ModelClient | null): void {
  if (!process.env.VITEST) throw new Error('__setModelClient is test-only')
  override = client
}

/**
 * The assistant's text, walked out of the output items.
 *
 * Deliberately NOT `res.output_text`: that convenience getter only exists on the SDK's response
 * class instance, so it is `undefined` for the plain JSON a test feeds in — which would make every
 * assertion about reply text vacuously pass.
 */
export function outputText(res: OpenAI.Responses.Response): string {
  return res.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content)
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

/**
 * Transient = the request never really landed (network, rate limit, server fault), so the persisted
 * conversation is fine and must be left alone. Anything else — a 400, a shape error — may mean the
 * conversation itself is malformed, and the caller's repair ladder trims it.
 *
 * Duck-typed on `status` FIRST, `instanceof` only as a fallback. `instanceof` against SDK error
 * classes is unreliable when a dual ESM/CJS resolution loads two copies of the module, and a
 * misclassification is not cosmetic here: calling a connection blip "non-transient" counts a
 * session failure, and four of those wipe the owner's conversation.
 */
export function isTransient(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { status?: unknown; name?: unknown }
  const status = typeof e.status === 'number' ? e.status : 0

  // 408/409 join the old 429/5xx set: the SDK's own retry policy treats them as "never landed",
  // which is exactly the rule this function encodes.
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true

  // Connection and timeout errors carry no status at all. APIUserAbortError also lands here and is
  // deliberately NOT transient — nothing passes an AbortSignal, so treating it as retryable would
  // be dead code that quietly changes the ladder the day someone wires one up.
  if (status !== 0) return false
  if (err instanceof APIConnectionError) return true
  return e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError'
}

/**
 * One stateless, tool-less completion — the shape all four "one-shot writer" surfaces share
 * (daily brief, nudge, backlog digest, weekly review).
 *
 * NEVER throws, and never returns an empty string: `null` means "use your template". That is the
 * contract each of those four already implemented separately; lifting it here is what collapses
 * them to two lines each.
 */
export async function composeText(params: {
  system: string
  user: string
  maxOutputTokens: number
  /** Undefined = SDK default. compose.ts deliberately passes none. */
  timeoutMs?: number
  maxRetries?: number
  /** Merged into the warn line so each surface keeps its own fields ({reminderId}, {slot}). */
  logContext?: Record<string, unknown>
}): Promise<string | null> {
  const client = modelClient()
  if (!client) return null

  try {
    const res = await client.create(
      {
        model: MODEL,
        instructions: params.system,
        input: params.user,
        max_output_tokens: params.maxOutputTokens,
        // The direct replacement for Anthropic's `thinking: { type: 'disabled' }`, and it is
        // load-bearing for exactly the same reason: reasoning tokens are drawn from
        // max_output_tokens. At a 200-token cap a reasoning pass would eat the entire budget and
        // return an empty completion, which falls through to the template and silently undoes the
        // whole surface. One sentence about a known task needs no reasoning.
        reasoning: { effort: 'none' },
        // These are the owner's private messages; there is no previous_response_id chain to keep,
        // so there is nothing to gain from server-side retention.
        store: false,
      },
      { timeout: params.timeoutMs, maxRetries: params.maxRetries },
    )

    if (res.status === 'incomplete') {
      log.warn(
        { ...params.logContext, reason: res.incomplete_details?.reason },
        'model returned an incomplete completion; using the templated fallback',
      )
      return null
    }

    const text = outputText(res)
    if (text.length === 0) {
      // Previously this branch returned the template with NO log line at all, which is what made a
      // permanently broken integration look like a merely terse Otto.
      log.warn(params.logContext ?? {}, 'model returned empty text; using the templated fallback')
      return null
    }
    return text
  } catch (err) {
    log.warn({ err, ...params.logContext }, 'model composition failed; using the templated fallback')
    return null
  }
}
