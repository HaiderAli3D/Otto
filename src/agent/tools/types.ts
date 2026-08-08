/**
 * What a tool AUTHOR writes.
 *
 * Deliberately has ZERO imports. The six tool-definition modules import from here, so none of them
 * depends — even type-only — on the module that constructs an API client, and none of them has to
 * know the wire shape of the provider currently in use.
 *
 * The wire envelope (`type: 'function'`, `strict`) is assembled in exactly one place, `buildTools()`
 * in ./index.ts. Keeping it out of the 18 literals is what lets a provider change be a one-function
 * edit rather than an eighteen-object one.
 */

/** The subset of JSON Schema the tool definitions actually use. No $ref, no oneOf, no format. */
export type JsonObjectSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: readonly string[]
}

/**
 * A tool as written. Note `parameters`, not `input_schema` — naming it after the field the API
 * actually wants means a stale definition is a compile error rather than a malformed request that
 * only fails in production.
 */
export type ToolDef = {
  name: string
  description: string
  parameters: JsonObjectSchema
}
