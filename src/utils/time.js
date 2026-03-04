import { DateTime } from 'luxon';

export function nowIso() {
  return new Date().toISOString();
}

export function formatYmd(date = new Date(), tz = 'Asia/Tokyo') {
  return DateTime.fromJSDate(date).setZone(tz).toFormat('yyyy-LL-dd');
}

export function toJpTime(iso, tz = 'Asia/Tokyo') {
  return DateTime.fromISO(iso).setZone(tz).toFormat('HH:mm');
}

export function addMinutes(iso, minutes) {
  return DateTime.fromISO(iso).plus({ minutes }).toUTC().toISO();
}

export function isPast(iso) {
  return new Date(iso).getTime() <= Date.now();
}
