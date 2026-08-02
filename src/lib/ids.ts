import { ulid } from 'ulid'

/** Server-generated stable alarm id. Idempotent arming on the app keys off this. */
export const newAlarmId = (): string => `alm_${ulid()}`

/** Reminder id. Distinct prefix from alarms so a mixed-up id fails loudly rather than silently. */
export const newReminderId = (): string => `rem_${ulid()}`

export const newFactId = (): string => `fct_${ulid()}`
