import { log } from '../lib/log.js'
import { getDevice } from './devices.js'
import { enqueueOutbound } from './outbox.js'
import { localDateKey } from './time.js'

/**
 * What the phone says about its own ability to do what it is told, and what Otto does about it.
 *
 * The load-bearing boundary in this system is that the server speaks in absolute instructions and
 * the app never interprets them. That leaves one thing the server cannot know: whether the app is
 * still ALLOWED to carry them out. FCM has no delivery receipt, `registerWithOs` refuses an alarm
 * silently when the exact-alarm grant is gone (and leaves the row ARMED so a later boot can retry
 * it, which is right), and a muted channel swallows a chase without a trace. Every one of those
 * looks, from here, exactly like success.
 *
 * The app has been reporting two of these three on every heartbeat for two releases. The route's
 * zod schema stripped them and nothing read them — so it was paying to compute a signal that was
 * discarded at the door. This is the reader.
 *
 * ONE MESSAGE PER PROBLEM PER LOCAL DAY, through the outbox like every other proactive message, and
 * keyed so the dedupe index enforces that rather than a counter someone has to maintain. A broken
 * grant does not heal on its own and the heartbeat runs constantly; without the key this would be a
 * message every fifteen minutes about a thing the owner already knows.
 */

export type DeviceHealth = {
  notificationsEnabled?: boolean
  mutedChannels?: string[]
  exactAlarmsPermitted?: boolean
}

/**
 * Nothing is said about a `false` the app cannot have meant.
 *
 * `undefined` means an older build that does not report this field, and treating that as "broken"
 * would warn every owner who has not updated — the exact false alarm that teaches someone to ignore
 * the channel. Only an explicit `false` is a problem.
 */
export async function reportDeviceHealth(deviceId: string, health: DeviceHealth): Promise<void> {
  const device = getDevice(deviceId)
  if (!device) return
  const waUserId = device.whatsappNumber
  if (waUserId === null) return

  const day = localDateKey(Date.now(), device.timezone)
  const warn = (problem: string, body: string): void => {
    log.warn({ deviceId, problem }, 'device health: telling the owner')
    enqueueOutbound({
      waUserId,
      deviceId,
      kind: 'system_warning',
      body,
      dedupeKey: `health:${problem}:${deviceId}:${day}`,
    })
  }

  // The sharpest of the three, and the only one that makes an ALARM fail. Android 12 and 12L can
  // revoke this from Settings; on 13+ USE_EXACT_ALARM is auto-granted to alarm apps, so seeing this
  // at all means something unusual has happened and the owner needs to hear about it.
  if (health.exactAlarmsPermitted === false) {
    warn(
      'exact-alarms',
      "⚠️ Your phone has stopped letting me set exact alarms, so any alarm I arm may not ring on time — " +
        'or at all. Open Android Settings → Apps → Otto → Alarms & reminders and turn it back on.',
    )
  }

  // Everything Otto says on the phone tier goes through a notification, so this silences the whole
  // fallback channel — including the one that exists for when WhatsApp cannot reach them.
  if (health.notificationsEnabled === false) {
    warn(
      'notifications',
      "⚠️ Notifications are switched off for Otto on your phone. Reminders I can't send over WhatsApp " +
        'have nowhere to go — turn them back on in Android Settings → Apps → Otto → Notifications.',
    )
  }

  // A muted channel is quieter than it looks: the notification still posts, so the phone reports it
  // delivered and the record shows a chase that landed. It just makes no sound.
  const muted = health.mutedChannels ?? []
  if (muted.length > 0) {
    warn(
      'muted-channels',
      `⚠️ You've muted ${muted.length === 1 ? 'one of my notification channels' : `${muted.length} of my notification channels`} ` +
        "on your phone, so those chases arrive silently. That's fine if you meant it — say so and I'll stop mentioning it.",
    )
  }
}
