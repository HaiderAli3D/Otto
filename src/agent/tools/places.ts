import type { Device } from '../../services/devices.js'
import { resolvePlace } from '../../services/places.js'
import {
  forgetPlace,
  listSavedPlaces,
  RESERVED_ALIASES,
  rememberPlace,
  SAVED_PLACE_CAP,
} from '../../services/savedPlaces.js'
import type { ToolDef } from './types.js'

/**
 * Named places: "the gym", "mum's", "the dentist".
 *
 * Separate from `remember_fact` because a place is a structured tuple the server joins on, not a
 * sentence the model reads — see the doc on `savedPlaces` in db/schema.ts. From the model's side the
 * distinction is simpler: a fact is something to KNOW about the owner, a place is somewhere it can
 * work out a journey to, and the descriptions below say so in those terms.
 *
 * Present whether or not Maps is configured, like every other integration tool: the tool block
 * renders at position 0 of the prompt and a list that changed shape per device would throw that
 * device's prompt cache away on every request. Saving and listing work regardless; only the lookup
 * needs a key, and it says so at call time.
 *
 * A literal array, never a function — see the contract in ./index.ts.
 */
export const placeTools: ToolDef[] = [
  {
    name: 'manage_places',
    description:
      'Remember, list or forget a place the owner has a name for — "the gym", "mum\'s", "the ' +
      'dentist". Save one the moment they tell you where somewhere is, so you never have to look ' +
      'it up or ask again; a saved place also wins outright when a search would otherwise return ' +
      'several. Use action "find" to check where somewhere is without planning anything. Their ' +
      'home and work addresses are NOT stored here — those are facts, saved with remember_fact ' +
      'under "home.address" and "work.address". This does not create alarms, reminders or events.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'forget', 'find'] },
        name: {
          type: 'string',
          description: 'What they call it, in their words: "the gym". Required for save, forget and find.',
        },
        address: {
          type: 'string',
          description:
            'The address, for save. Omit it and the place is looked up by name first — which is ' +
            'usually what you want, since that also records the exact location.',
        },
      },
      required: ['action'],
    },
  },
]

/** Cap on how many places a list returns. This is prompt budget, re-sent on every later turn. */
const LIST_LIMIT = 25

function placeView(p: { label: string; address: string }) {
  return { name: p.label, address: p.address }
}

export async function managePlaces(device: Device, a: Record<string, unknown>): Promise<unknown> {
  const action = String(a.action ?? '').toLowerCase()
  const name = typeof a.name === 'string' ? a.name.trim() : ''
  const address = typeof a.address === 'string' ? a.address.trim() : ''

  if (action === 'list') {
    const all = listSavedPlaces(device.deviceId)
    return {
      places: all.slice(0, LIST_LIMIT).map(placeView),
      more: all.length > LIST_LIMIT ? all.length - LIST_LIMIT : undefined,
    }
  }

  if (name.length === 0) return { error: `manage_places "${action}" needs a name` }

  if (action === 'forget') {
    return forgetPlace(device.deviceId, name)
      ? { forgot: name }
      : { error: `no saved place called "${name}"` }
  }

  if (action === 'find' || action === 'save') {
    // A runaway backstop, not a limit anyone reaches: a person has a dozen named places, and a loop
    // writing them would otherwise grow the prompt-adjacent list without bound.
    if (action === 'save' && listSavedPlaces(device.deviceId).length >= SAVED_PLACE_CAP) {
      return { error: `${SAVED_PLACE_CAP} saved places is the ceiling — forget one before saving another` }
    }

    // A save WITHOUT an address resolves first, so the row carries a place id and coordinates
    // rather than only the owner's words. A save WITH one takes them at their word and never
    // spends a lookup — they know where their gym is better than a search does.
    if (action === 'save' && address.length > 0) {
      const saved = rememberPlace({ deviceId: device.deviceId, alias: name, label: name, address })
      return saved === null ? reservedError(name) : { saved: placeView(saved) }
    }

    const resolution = await resolvePlace(device, name)
    if (resolution.kind === 'ambiguous') {
      return { ambiguous: resolution.candidates.map(placeView) }
    }
    if (resolution.kind === 'unknown') {
      return { error: resolution.note }
    }
    if (action === 'find') return { found: placeView(resolution.place), knownAs: resolution.place.source }

    const saved = rememberPlace({
      deviceId: device.deviceId,
      alias: name,
      label: name,
      address: resolution.place.address,
      googlePlaceId: resolution.place.placeId,
      latLng: resolution.place.latLng,
    })
    return saved === null ? reservedError(name) : { saved: placeView(saved) }
  }

  return { error: `unknown action "${action}" — use save, list, forget or find` }
}

function reservedError(name: string) {
  return {
    error:
      `"${name}" is one of ${RESERVED_ALIASES.join('/')}, which Otto reads from its own memory. ` +
      'Save it with remember_fact under "home.address" or "work.address" instead.',
  }
}
