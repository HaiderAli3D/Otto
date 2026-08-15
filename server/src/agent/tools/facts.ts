import type { ToolDef } from './types.js'

/**
 * Memory tools: durable facts about the owner, keyed so a rewrite corrects rather than duplicates.
 *
 * The most relevant facts are already rendered into the cached system block, so recall_facts is for
 * the long tail and for key collisions — the descriptions say so, to stop the model spending a
 * round-trip re-reading what it can already see.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const factTools: ToolDef[] = [
  {
    name: 'remember_fact',
    description:
      'Save one durable fact about the owner so it is available in every future conversation. ' +
      'Call this whenever they state something about themselves that will still matter next ' +
      'month: how they commute, when they work out, who the people in their life are, standing ' +
      'preferences, how they like to be reminded. Do NOT ask permission first — just save it and ' +
      'carry on. Do NOT save tasks (use create_reminder), one-off state ("I\'m at the shops"), or ' +
      'anything you could look up. Reuse an existing key to correct or replace a fact rather than ' +
      'adding a near-duplicate — writing the same key overwrites it.',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description:
            'Stable dotted slug, lowercase, e.g. "work.commute", "health.gym_days", "people.sam". Three keys are read by name by Otto itself and must be spelled exactly: "home.address" and "work.address" (full street addresses — leave-by alarms cannot use live traffic without them) and "travel.default_buffer". Check recall_facts first if you might be replacing an existing fact.',
        },
        value: { type: 'string', description: 'ONE short sentence, written in the third person.' },
        category: {
          type: 'string',
          enum: ['profile', 'preference', 'routine', 'project', 'person', 'health', 'general'],
        },
        pinned: {
          type: 'boolean',
          description: 'Always keep in context. Reserve for a handful of load-bearing facts.',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'recall_facts',
    description:
      'Search everything Otto remembers about the owner, including facts not currently shown to ' +
      'you. The most relevant facts are already in your context; call this when the owner asks ' +
      'what you know, when you need an older detail, or before writing a fact whose key might ' +
      'already exist.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keywords or a key prefix, e.g. "work" or "gym".' } },
    },
  },
  {
    name: 'forget_fact',
    description: 'Delete a remembered fact by key. Use when the owner asks you to forget something.',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
]
