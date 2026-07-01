import { ulid } from 'ulid'

/** Server-generated stable alarm id. Idempotent arming on the app keys off this. */
export const newAlarmId = (): string => `alm_${ulid()}`

/** Fallback device id (the app usually mints its own `dev_<uuid>`). */
export const newDeviceId = (): string => `dev_${ulid().toLowerCase()}`
