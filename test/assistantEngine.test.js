import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_SCHEMA,
  AGENDA_REWRITE_SCHEMA,
  CLOSE_SUMMARY_SCHEMA,
  buildActiveConversationWindow,
  buildActionPrompt,
  buildClosedBusinessDayWindow,
  formatDailyTimelineMarkdown,
  normalizeAgendaEventsFromModel
} from '../src/services/assistantEngine.js';

test('ACTION_SCHEMA includes memory action', () => {
  assert.ok(ACTION_SCHEMA.properties.action.enum.includes('memory'));
});

test('buildActionPrompt explains when memory should be selected', () => {
  const prompt = buildActionPrompt({
    text: '大学時代のこと覚えてる？',
    dateKey: '2026-03-10',
    localTime: '12:00:00',
    timeZone: 'America/Vancouver',
    conversationText: '- 会話履歴なし',
    agendaContext: '- 予定なし'
  });

  assert.match(prompt, /次の6つから必ず1つだけ選んでください。/);
  assert.match(prompt, /- memory: /);
  assert.match(prompt, /長期に保持された人物、所属、過去イベント、継続プロジェクト、背景事情などの記憶参照が主目的なら memory を選ぶ。/);
});

test('AGENDA_REWRITE_SCHEMA requires every event item property for strict mode', () => {
  const itemSchema = AGENDA_REWRITE_SCHEMA.properties.events.items;
  const propertyKeys = Object.keys(itemSchema.properties).sort();
  const requiredKeys = [...itemSchema.required].sort();

  assert.deepEqual(requiredKeys, propertyKeys);
  assert.ok(requiredKeys.includes('id'));
});

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
      id: '',
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
  assert.notEqual(result[1].eventId, '');
});

test('normalizeAgendaEventsFromModel ignores non-empty ids for new events', () => {
  const result = normalizeAgendaEventsFromModel([
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
  ], new Map());

  assert.match(result[0].eventId, /^draft-event-/);
  assert.notEqual(result[0].eventId, 'hallucinated-id');
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

test('buildActiveConversationWindow uses 03:00 as the business day boundary', () => {
  assert.deepEqual(
    buildActiveConversationWindow({
      dateKey: '2026-03-11',
      localTime: '02:30:00',
      timeZone: 'UTC'
    }),
    {
      since: '2026-03-10T03:00:00.000Z',
      until: '2026-03-11T02:30:00.000Z'
    }
  );

  assert.deepEqual(
    buildActiveConversationWindow({
      dateKey: '2026-03-11',
      localTime: '12:30:00',
      timeZone: 'UTC'
    }),
    {
      since: '2026-03-11T03:00:00.000Z',
      until: '2026-03-11T12:30:00.000Z'
    }
  );
});

test('buildClosedBusinessDayWindow spans exactly one 03:00-based business day', () => {
  assert.deepEqual(
    buildClosedBusinessDayWindow({
      dateKey: '2026-03-10',
      timeZone: 'UTC'
    }),
    {
      since: '2026-03-10T03:00:00.000Z',
      until: '2026-03-11T03:00:00.000Z'
    }
  );
});

test('CLOSE_SUMMARY_SCHEMA requires notes and eventNotes', () => {
  const propertyKeys = Object.keys(CLOSE_SUMMARY_SCHEMA.properties).sort();
  const requiredKeys = [...CLOSE_SUMMARY_SCHEMA.required].sort();

  assert.deepEqual(requiredKeys, propertyKeys);
  assert.deepEqual(requiredKeys, ['eventNotes', 'notes']);
});

test('formatDailyTimelineMarkdown renders detailed event and note sections', () => {
  const markdown = formatDailyTimelineMarkdown({
    dateKey: '2026-03-11',
    events: [
      {
        eventId: 'evt-1',
        allDay: false,
        startTime: '09:00:00',
        endTime: '10:30:00',
        title: '定例MTG',
        status: 'done',
        detail: '採用進捗のレビュー',
        notifyOnEnd: true
      }
    ],
    notes: [
      '田中さんが来週から採用窓口に加わることを共有した。'
    ],
    eventNotesById: new Map([
      ['evt-1', ['開始時刻を30分後ろ倒しした。', '議事録は採用フォルダに残した。']]
    ])
  });

  assert.match(markdown, /^# 2026-03-11/m);
  assert.match(markdown, /^## 今日の予定/m);
  assert.match(markdown, /- \[done\] 09:00-10:30 定例MTG/);
  assert.match(markdown, /  - 詳細: 採用進捗のレビュー/);
  assert.match(markdown, /  - 通知: 終了時通知あり/);
  assert.match(markdown, /  - 補足: 開始時刻を30分後ろ倒しした。/);
  assert.match(markdown, /^## ノート/m);
  assert.match(markdown, /- 田中さんが来週から採用窓口に加わることを共有した。/);
});

test('formatDailyTimelineMarkdown renders empty sections consistently', () => {
  const markdown = formatDailyTimelineMarkdown({
    dateKey: '2026-03-12',
    events: [],
    notes: [],
    eventNotesById: new Map()
  });

  assert.match(markdown, /## 今日の予定\n- 予定なし/);
  assert.match(markdown, /## ノート\n- なし/);
});
