import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoogleCalendarSyncPlan,
  extractTimeRange
} from './googleCalendarSync.js';

test('extractTimeRange parses HH:MM range', () => {
  assert.deepEqual(extractTimeRange('撮影 14:00〜18:00'), {
    startTime: '14:00:00',
    endTime: '18:00:00'
  });
});

test('extractTimeRange parses Japanese hour range', () => {
  assert.deepEqual(extractTimeRange('撮影は14時〜18時です'), {
    startTime: '14:00:00',
    endTime: '18:00:00'
  });
});

test('buildGoogleCalendarSyncPlan creates event sync only for timed tasks', () => {
  const plan = buildGoogleCalendarSyncPlan({
    dateKey: '2026-03-07',
    localTasks: [
      { id: 'task-a', title: 'Singular Radio撮影', detail: '14:00〜18:00', status: 'todo' },
      { id: 'task-b', title: 'Laplace Shorts', detail: '', status: 'todo' }
    ],
    mappings: [
      {
        localTaskId: 'task-b',
        googleCalendarEventId: 'event-b',
        calendarId: 'primary',
        dateKey: '2026-03-07'
      }
    ]
  });

  assert.deepEqual(
    plan.map((item) => ({ type: item.type, localTaskId: item.localTaskId })),
    [
      { type: 'create', localTaskId: 'task-a' },
      { type: 'delete', localTaskId: 'task-b' }
    ]
  );
});
