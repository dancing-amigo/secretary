import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAgendaEventsFromModel } from '../src/services/assistantEngine.js';

test('normalizeAgendaEventsFromModel assigns app-side ids for new events', () => {
  const currentEventsById = new Map([
    ['existing-1', { eventId: 'existing-1', title: '既存予定' }]
  ]);

  const result = normalizeAgendaEventsFromModel([
    {
      id: 'existing-1',
      isNew: false,
      title: '既存予定',
      status: 'todo',
      notifyOnEnd: false,
      detail: '',
      allDay: true,
      startTime: '',
      endTime: ''
    },
    {
      id: 'hallucinated-id',
      isNew: true,
      title: '新規予定',
      status: 'todo',
      notifyOnEnd: false,
      detail: '',
      allDay: false,
      startTime: '12:00:00',
      endTime: '14:00:00'
    }
  ], currentEventsById);

  assert.equal(result[0].eventId, 'existing-1');
  assert.match(result[1].eventId, /^draft-event-/);
  assert.notEqual(result[1].eventId, 'hallucinated-id');
});

test('normalizeAgendaEventsFromModel rejects missing existing ids', () => {
  const currentEventsById = new Map();

  assert.throws(() => normalizeAgendaEventsFromModel([
    {
      id: 'missing-existing',
      isNew: false,
      title: '更新予定',
      status: 'todo',
      notifyOnEnd: false,
      detail: '',
      allDay: true,
      startTime: '',
      endTime: ''
    }
  ], currentEventsById), /既存 event の id が現在の予定一覧に存在しません。/);
});
