// Owned by the DAILY BRIEF feature branch.
// Phase 0 seam: the scheduler already routes 'brief' here and `handlers/index.ts` already registers
// `seedBrief`, so that branch fills in this file and never touches the switch in scheduler/loop.ts
// or the seeder registry — which is what makes the four Phase 1 branches mergeable in any order.
import { nextBriefRunAt } from '../../lib/briefSchedule.js'
import { log } from '../../lib/log.js'
import { runBrief as deliverBrief, scheduleBriefChain } from '../brief.js'
import { getDevice, type Device } from '../devices.js'
import type { Job } from '../jobs.js'
import { getSettings } from '../settings.js'
import type { JobOutcome } from './types.js'

/**
 * Return the next brief instant to keep the chain alive, or null to end it. Do NOT delete or
 * re-enqueue the job yourself — the scheduler reschedules this same row, so the chain can never
 * fall through a crash window.
 *
 * NEVER null for a device that still exists, even with both slots disabled: `nextBriefRunAt` always
 * answers with a real future instant, so turning the brief back on needs no re-seed. Only a device
 * that has gone away ends the chain.
 */
export async function runBrief(job: Job): Promise<JobOutcome> {
  if (!job.deviceId) return null
  const device = getDevice(job.deviceId)
  if (!device) return null
  const now = Date.now()

  // Swallowed on purpose. An exception escaping here leaves the row unsettled, which means it is
  // still due — and the scheduler would re-run it every 15 seconds forever, composing a brief on
  // each pass. Losing one day's brief to a bad calendar response is strictly better.
  try {
    await deliverBrief(device, job.runAtMillis, now)
  } catch (err) {
    log.error({ err, deviceId: device.deviceId }, 'brief: delivery failed; advancing the chain anyway')
  }

  // Settings re-read AFTER delivery: `markBriefSent` has just rewritten this row, and the next
  // instant must be computed from what is now on disk rather than from the snapshot taken before.
  return nextBriefRunAt(getSettings(device.deviceId), device.timezone, now)
}

/** Idempotent; runs on every boot and after every gc pass. See DeviceSeeder in ./types.ts. */
export function seedBrief(device: Device, nowMillis: number): void {
  scheduleBriefChain(device, nowMillis)
}
