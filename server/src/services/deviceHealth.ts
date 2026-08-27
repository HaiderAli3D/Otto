import { log } from '../lib/log.js'
import { getDevice } from './devices.js'
import { enqueueOutbound } from './outbox.js'
import { localDateKey } from './time.js'

/**
 * What the phone says about its own ability to do what it is told, and what Otto does about it.
 *
 * The app has exactly ONE job — ringing a real alarm — so there is exactly one thing worth warning
 * about here, and it is whether the OS will still let it. `registerWithOs` refuses silently when the
 * exact-alarm grant is gone (and leaves the row ARMED so a later boot can retry it, which is right),
 * FCM has no delivery receipt, and from the server an alarm the OS refused looks exactly like one
 * that is set. Nothing else can tell the owner.
 *
 * The other two fields the app reports are accepted and ignored on purpose — see below.
 *
 * ONE MESSAGE PER PROBLEM PER LOCAL DAY, over WhatsApp like everything else Otto says, and keyed so
 * the dedupe index enforces that rather than a counter someone has to maintain. A broken grant does
 * not heal on its own and the heartbeat runs constantly; without the key this would be a message
 * every fifteen minutes about a thing the owner already knows.
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

  // `notificationsEnabled` and `mutedChannels` are READ AND DELIBERATELY IGNORED.
  //
  // They mattered while the phone carried chases. It does not: Otto says everything over WhatsApp
  // and the app is an alarm device (see the transport comment in services/outbox.ts). A muted
  // notification channel now silences nothing the owner would miss, and warning them about it would
  // be Otto complaining about a setting that no longer affects him — which is exactly the kind of
  // false alarm that teaches someone to ignore the channel the exact-alarm warning above needs.
  //
  // Still accepted at the route and still logged, because the day that decision is revisited these
  // are the two signals it will need, and because an app already reporting them should not have to
  // be re-released to start being heard.
  if (health.notificationsEnabled === false || (health.mutedChannels ?? []).length > 0) {
    log.info(
      { deviceId, notificationsEnabled: health.notificationsEnabled, mutedChannels: health.mutedChannels },
      'device health: notifications are limited, which is fine — Otto speaks over WhatsApp',
    )
  }
}
