import { ulid } from 'ulid'

/** Server-generated stable alarm id. Idempotent arming on the app keys off this. */
export const newAlarmId = (): string => `alm_${ulid()}`
