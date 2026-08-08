import type OpenAI from 'openai'
import type { ModelClient } from '../src/agent/llm.js'

type Params = OpenAI.Responses.ResponseCreateParamsNonStreaming
type Response = OpenAI.Responses.Response
type OutputItem = OpenAI.Responses.ResponseOutputItem

/** One scripted turn: either a response to return, or an error to throw. */
export type Scripted =
  | {
      output: OutputItem[]
      status?: 'completed' | 'incomplete'
      incompleteReason?: string
      usage?: Partial<OpenAI.Responses.ResponseUsage>
    }
  | Error

/**
 * A fake ModelClient that plays a script and records what it was asked for.
 *
 * The point is asserting on the REQUEST the runner built, not just on the reply it got back. Until
 * this existed the suite could not see the wire format at all: `test/setup-env.ts` omits the API
 * key, so every test ran the templated fallback path and would have stayed green through a
 * completely malformed integration.
 */
export function fakeModel(script: Scripted[]) {
  const requests: Params[] = []
  const remaining = [...script]

  const client: ModelClient = {
    async create(params) {
      // structuredClone is LOAD-BEARING. runLoop pushes onto the very array it passed as `input`,
      // so storing the reference would make every recorded request show the FINAL state of the
      // conversation — and every "what did step 0 send" assertion would pass vacuously.
      requests.push(structuredClone(params))

      const next = remaining.shift()
      if (next === undefined) {
        throw new Error(`fakeModel: request #${requests.length} arrived with an empty script`)
      }
      if (next instanceof Error) throw next

      return {
        id: `resp_${requests.length}`,
        object: 'response',
        created_at: 0,
        model: params.model,
        status: next.status ?? 'completed',
        output: next.output,
        incomplete_details: next.incompleteReason ? { reason: next.incompleteReason } : null,
        error: null,
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 120,
          ...next.usage,
        },
      } as unknown as Response
    },
  }

  return {
    client,
    requests,
    /** Script entries never consumed — a non-zero count usually means the loop exited early. */
    get unused() {
      return remaining.length
    },
  }
}

// ── Output-item builders ──────────────────────────────────────────────────────

export const say = (text: string, id = 'msg_1'): OutputItem =>
  ({
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }) as unknown as OutputItem

/** `args` as a string is passed through verbatim, so a test can send malformed JSON on purpose. */
export const fnCall = (name: string, args: unknown, callId: string): OutputItem =>
  ({
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    status: 'completed',
  }) as unknown as OutputItem

export const think = (id = 'rs_1'): OutputItem =>
  ({ type: 'reasoning', id, summary: [], encrypted_content: 'ENCRYPTEDBLOB' }) as unknown as OutputItem
