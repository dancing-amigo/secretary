import axios from 'axios';
import { config } from '../config.js';

export async function getBusySlots(dayStartIso, dayEndIso) {
  if (!config.gcal.enabled || !config.gcal.accessToken) return [];
  const body = {
    timeMin: dayStartIso,
    timeMax: dayEndIso,
    timeZone: config.tz,
    items: [{ id: config.gcal.calendarId }]
  };

  const res = await axios.post('https://www.googleapis.com/calendar/v3/freeBusy', body, {
    headers: {
      Authorization: `Bearer ${config.gcal.accessToken}`,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });

  return res.data?.calendars?.[config.gcal.calendarId]?.busy || [];
}

export async function upsertTaskEvent(task) {
  if (!config.gcal.enabled || !config.gcal.accessToken) return { skipped: true };
  if (!task.scheduledStart || !task.scheduledEnd) return { skipped: true };

  const body = {
    summary: `[Task] ${task.title}`,
    description: `TaskId: ${task.id}`,
    start: { dateTime: task.scheduledStart, timeZone: config.tz },
    end: { dateTime: task.scheduledEnd, timeZone: config.tz },
    extendedProperties: {
      private: {
        task_id: task.id
      }
    }
  };

  const res = await axios.post(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.gcal.calendarId)}/events`,
    body,
    {
      headers: {
        Authorization: `Bearer ${config.gcal.accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  );

  return { eventId: res.data.id };
}
