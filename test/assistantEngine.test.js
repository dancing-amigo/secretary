import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import {
  ACTION_SCHEMA,
  AGENDA_REWRITE_SCHEMA,
  CLOSE_SUMMARY_SCHEMA,
  VISITOR_ACTION_SCHEMA,
  buildActiveConversationWindow,
  buildActionPrompt,
  buildVisitorActionPrompt,
  buildClosedBusinessDayWindow,
  buildDailyXPostPrompt,
  buildMorningGreetingPrompt,
  formatDailyTimelineMarkdown,
  normalizeAgendaEventsFromModel,
  processLineMessage,
  prepareDailyClose,
  runMorningPlan
} from '../src/services/assistantEngine.js';

const ORIGINAL_PUBLIC_CALENDAR_URL = config.app.publicCalendarUrl;

test('ACTION_SCHEMA includes memory action', () => {
  assert.ok(ACTION_SCHEMA.properties.action.enum.includes('memory'));
  assert.ok(ACTION_SCHEMA.properties.action.enum.includes('register_visitor'));
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

  assert.match(prompt, /次の7つから必ず1つだけ選んでください。/);
  assert.match(prompt, /- memory: /);
  assert.match(prompt, /- register_visitor: /);
  assert.match(prompt, /長期に保持された人物、所属、過去イベント、継続プロジェクト、背景事情などの記憶参照が主目的なら memory を選ぶ。/);
});

test('VISITOR_ACTION_SCHEMA exposes read-only visitor actions including forbidden_action', () => {
  assert.deepEqual(VISITOR_ACTION_SCHEMA.properties.action.enum, [
    'list_events',
    'memory',
    'others',
    'forbidden_action'
  ]);
});

test('buildVisitorActionPrompt routes mutation requests to forbidden_action', () => {
  const prompt = buildVisitorActionPrompt({
    text: '予定を追加して',
    dateKey: '2026-03-10',
    localTime: '12:00:00',
    timeZone: 'America/Vancouver',
    conversationText: '- 会話履歴なし',
    agendaContext: '- 予定なし'
  });

  assert.match(prompt, /forbidden_action/);
  assert.match(prompt, /予定の追加、変更、削除、完了報告、代理実行は forbidden_action を最優先する。/);
  assert.match(prompt, /SOUL\.md や USER\.md を変えてほしい依頼/);
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

test('buildMorningGreetingPrompt reads from previous daily log instead of close summary', () => {
  const prompt = buildMorningGreetingPrompt({
    dateKey: '2026-03-12',
    localTime: '08:00:00',
    timeZone: 'America/Vancouver',
    dailyLogText: '# 2026-03-11\n\n## 今日の予定\n- 予定なし\n',
    agendaText: '- 予定なし'
  });

  assert.match(prompt, /前日の日次ログ:/);
  assert.doesNotMatch(prompt, /前日締めサマリー:/);
  assert.doesNotMatch(prompt, /内部サマリー:/);
});

test('buildDailyXPostPrompt reads from previous daily log instead of close summary', () => {
  const prompt = buildDailyXPostPrompt({
    dateKey: '2026-03-11',
    localTime: '03:05:00',
    timeZone: 'America/Vancouver',
    conversationText: '- 会話履歴なし',
    agendaText: '- 予定なし',
    dailyLogText: '# 2026-03-11\n\n## ノート\n- なし\n'
  });

  assert.match(prompt, /前日の日次ログ:/);
  assert.doesNotMatch(prompt, /前日締めサマリー:/);
  assert.doesNotMatch(prompt, /内部サマリー:/);
});

test('prepareDailyClose writes daily log and saves only minimal close state', async () => {
  const notificationUpdates = [];
  const writtenRecords = [];

  const result = await prepareDailyClose({
    userId: 'user-1',
    dateKey: '2026-03-11',
    localTime: '03:00:00',
    timeZone: 'UTC'
  }, {
    loadClosedBusinessDayConversationContextImpl: async () => ({
      since: '2026-03-11T03:00:00.000Z',
      until: '2026-03-12T03:00:00.000Z',
      turns: [],
      text: '- 会話履歴なし'
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({
        events: [{ eventId: 'evt-1', title: 'MTG', status: 'done', allDay: true, detail: '', notifyOnEnd: false }]
      })
    }),
    getNotificationRecordImpl: async () => null,
    generateCloseSummaryImpl: async () => ({
      notes: ['進捗共有を完了した。'],
      eventNotesById: new Map(),
      recordMarkdown: '# 2026-03-11\n\n## 今日の予定\n- [done] 終日 MTG\n\n## ノート\n- 進捗共有を完了した。\n'
    }),
    writeDailyTimelineRecordImpl: async (payload) => {
      writtenRecords.push(payload);
    },
    updateNotificationRecordImpl: async (payload) => {
      notificationUpdates.push(payload);
    }
  });

  assert.deepEqual(writtenRecords, [{
    dateKey: '2026-03-11',
    entryMarkdown: '# 2026-03-11\n\n## 今日の予定\n- [done] 終日 MTG\n\n## ノート\n- 進捗共有を完了した。\n'
  }]);
  assert.equal(notificationUpdates.length, 1);
  assert.equal(notificationUpdates[0].slot, 'close');
  assert.equal(notificationUpdates[0].dateKey, '2026-03-11');
  assert.ok(notificationUpdates[0].updates.recordUpdatedAt);
  assert.equal('summaryContextText' in notificationUpdates[0].updates, false);
  assert.equal('summaryGeneratedAt' in notificationUpdates[0].updates, false);
  assert.equal('summarySource' in notificationUpdates[0].updates, false);
  assert.deepEqual(result, {
    reusedSummary: false,
    recordUpdated: true
  });
});

test('runMorningPlan reads previous daily log and fails hard when it is missing', async () => {
  await assert.rejects(
    runMorningPlan({
      getLocalDateContextImpl: () => ({
        dateKey: '2026-03-12',
        localTime: '08:00:00',
        timeZone: 'UTC'
      }),
      createExecutionContextImpl: () => ({
        getCalendarSnapshot: async () => ({ events: [] })
      }),
      readDailyTimelineRecordImpl: async () => {
        throw new Error('Google Drive file not found: record/timeline/days/2026-03-11.md');
      },
      generateMorningGreetingImpl: async () => {
        throw new Error('should not be called');
      }
    }),
    /record\/timeline\/days\/2026-03-11\.md/
  );
});

test('processLineMessage keeps owner route behavior for modify_events', async () => {
  const calls = [];

  const reply = await processLineMessage({
    senderUserId: 'owner-1',
    ownerUserId: 'owner-1',
    senderRole: 'owner',
    text: '予定を追加して'
  }, {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async ({ userId }) => ({
      text: `conversation:${userId}`
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async (operation) => {
        calls.push(['calendar', operation]);
        return {
          events: [{ eventId: 'evt-1', title: '既存予定', status: 'todo', allDay: true, detail: '', notifyOnEnd: false }]
        };
      }
    }),
    classifyActionImpl: async () => ({ action: 'modify_events', reason: 'owner update' }),
    rewriteAgendaEventsImpl: async ({ userId, profileContext }) => {
      calls.push(['rewrite', userId, profileContext?.scope]);
      return {
        outcome: 'updated',
        message: '更新しました。',
        events: [{
          id: 'evt-1',
          isNew: false,
          title: '既存予定',
          status: 'done',
          notifyOnEnd: false,
          detail: '',
          allDay: true,
          startTime: '',
          endTime: ''
        }]
      };
    },
    reconcileAgendaEventsForDateImpl: async ({ nextEvents }) => {
      calls.push(['reconcile', nextEvents[0].status]);
      return { enabled: true, failed: 0, retryable: 0 };
    },
    pullGoogleCalendarEventsForDateImpl: async () => ({
      failed: false,
      events: []
    }),
    reconcileReminderSchedulesForDateImpl: async ({ dateKey }) => {
      calls.push(['reminder', dateKey]);
    }
  });

  assert.equal(reply, '更新しました。');
  assert.deepEqual(calls, [
    ['calendar', 'line_message_owner'],
    ['rewrite', 'owner-1', 'owner_readonly'],
    ['reconcile', 'done'],
    ['reminder', '2026-03-12']
  ]);
});

test('processLineMessage returns owner agenda for visitor list_events', async () => {
  config.app.publicCalendarUrl = 'https://calendar.example.com/public';
  const reply = await processLineMessage({
    senderUserId: 'visitor-1',
    ownerUserId: 'owner-1',
    senderRole: 'visitor',
    text: '今日の予定は？'
  }, {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async ({ userId }) => ({
      text: `conversation:${userId}`
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async (operation) => {
        assert.equal(operation, 'line_message_visitor');
        return {
          events: [{ eventId: 'evt-1', title: '打ち合わせ', status: 'todo', allDay: false, startTime: '10:00:00', endTime: '11:00:00', detail: '', notifyOnEnd: false }]
        };
      }
    }),
    classifyVisitorActionImpl: async ({ conversationContext, profileContext }) => {
      assert.equal(conversationContext.text, 'conversation:visitor-1');
      assert.equal(profileContext.scope, 'owner_readonly');
      return { action: 'list_events', reason: 'read only' };
    },
    resolveVisitorIdentityImpl: async () => ({
      status: 'registered',
      lineUserId: 'visitor-1',
      personId: 'person-1',
      personSummary: {
        name: 'Visitor One',
        role: 'friend',
        relationshipToOwner: 'friend'
      },
      scopePolicy: {
        allowedScopes: ['owner.today_agenda.basic']
      }
    }),
    reviewVisitorReplyImpl: async ({ candidateReply, sources }) => {
      assert.equal(sources[0].scope, 'owner.today_agenda.basic');
      assert.equal(sources[1].kind, 'general');
      return { decision: 'allow', message: candidateReply };
    }
  });

  assert.match(reply, /^このアカウントのオーナーの今日の予定です。/);
  assert.match(reply, /10:00-11:00 \[todo\]/);
  assert.match(reply, /打ち合わせ/);
  assert.match(reply, /https:\/\/calendar\.example\.com\/public/);
  config.app.publicCalendarUrl = ORIGINAL_PUBLIC_CALENDAR_URL;
});

test('processLineMessage rejects visitor mutation requests without side effects', async () => {
  let sideEffectCount = 0;

  const reply = await processLineMessage({
    senderUserId: 'visitor-1',
    ownerUserId: 'owner-1',
    senderRole: 'visitor',
    text: '予定を追加して'
  }, {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async ({ userId }) => ({
      text: `conversation:${userId}`
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({ events: [] })
    }),
    resolveVisitorIdentityImpl: async () => ({
      status: 'registered',
      lineUserId: 'visitor-1',
      personId: 'person-1',
      personSummary: {
        name: 'Visitor One',
        role: '',
        relationshipToOwner: ''
      },
      scopePolicy: { allowedScopes: [] }
    }),
    classifyVisitorActionImpl: async () => ({ action: 'forbidden_action', reason: 'mutation' }),
    reconcileAgendaEventsForDateImpl: async () => {
      sideEffectCount += 1;
    },
    writeSoulMarkdownImpl: async () => {
      sideEffectCount += 1;
    },
    writeUserMarkdownImpl: async () => {
      sideEffectCount += 1;
    }
  });

  assert.match(reply, /予定の追加や変更、プロフィールや記憶の更新はできません/);
  assert.equal(sideEffectCount, 0);
});

test('processLineMessage uses sender conversation for visitor memory and others', async () => {
  const calls = [];

  const deps = {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async ({ userId }) => ({
      text: `conversation:${userId}`
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({ events: [] })
    }),
    answerFromMemoryWithMetadataImpl: async ({ conversationContext, profileContext }) => {
      calls.push(['memory', conversationContext.text, profileContext?.scope]);
      return {
        reply: 'memory reply',
        sources: [{
          kind: 'memory',
          sourceId: 'memory-1',
          scope: 'owner.memory.people',
          scopes: ['owner.memory.people'],
          summary: 'memory summary'
        }]
      };
    },
    generateOthersReplyImpl: async ({ conversationContext, profileContext }) => {
      calls.push(['others', conversationContext.text, profileContext?.scope]);
      return 'others reply';
    },
    resolveVisitorIdentityImpl: async () => ({
      status: 'registered',
      lineUserId: 'visitor-1',
      personId: 'person-1',
      personSummary: {
        name: 'Visitor One',
        role: '',
        relationshipToOwner: ''
      },
      scopePolicy: { allowedScopes: ['owner.memory.people'] }
    }),
    reviewVisitorReplyImpl: async ({ candidateReply, sources }) => {
      calls.push(['review', sources[0]?.kind || 'none']);
      return { decision: 'allow', message: candidateReply };
    }
  };

  const memoryReply = await processLineMessage({
    senderUserId: 'visitor-1',
    ownerUserId: 'owner-1',
    senderRole: 'visitor',
    text: '覚えてる？'
  }, {
    ...deps,
    classifyVisitorActionImpl: async () => ({ action: 'memory', reason: 'memory' })
  });

  const othersReply = await processLineMessage({
    senderUserId: 'visitor-1',
    ownerUserId: 'owner-1',
    senderRole: 'visitor',
    text: '雑談しよう'
  }, {
    ...deps,
    classifyVisitorActionImpl: async () => ({ action: 'others', reason: 'chat' })
  });

  assert.equal(memoryReply, 'memory reply');
  assert.equal(othersReply, 'others reply');
  assert.deepEqual(calls, [
    ['memory', 'conversation:visitor-1', 'owner_readonly'],
    ['review', 'memory'],
    ['others', 'conversation:visitor-1', 'owner_readonly'],
    ['review', 'general']
  ]);
});

test('processLineMessage handles owner register_visitor action', async () => {
  const reply = await processLineMessage({
    senderUserId: 'owner-1',
    ownerUserId: 'owner-1',
    senderRole: 'owner',
    text: 'さっきの人を山本圭亮として登録して'
  }, {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async () => ({
      text: '- 会話履歴なし'
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({ events: [] })
    }),
    classifyActionImpl: async () => ({ action: 'register_visitor', reason: 'visitor registration' }),
    registerVisitorFromOwnerTextImpl: async () => ({
      outcome: 'updated',
      message: '山本圭亮として登録しました。'
    })
  });

  assert.equal(reply, '山本圭亮として登録しました。');
});

test('processLineMessage records pending visitor and denies owner data for unregistered visitor list_events', async () => {
  config.app.publicCalendarUrl = 'https://calendar.example.com/public';
  let pendingCalls = 0;

  const reply = await processLineMessage({
    senderUserId: 'visitor-raw',
    ownerUserId: 'owner-1',
    senderRole: 'visitor',
    text: '今日の予定は？'
  }, {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async () => ({
      text: '- 会話履歴なし'
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({ events: [] })
    }),
    classifyVisitorActionImpl: async () => ({ action: 'list_events', reason: 'ask agenda' }),
    resolveVisitorIdentityImpl: async () => ({
      status: 'unregistered',
      lineUserId: 'visitor-raw',
      personId: '',
      personSummary: null,
      scopePolicy: { allowedScopes: [] }
    }),
    ensurePendingVisitorRegisteredImpl: async ({ lineUserId, ownerUserId, latestMessage }) => {
      pendingCalls += 1;
      assert.equal(lineUserId, 'visitor-raw');
      assert.equal(ownerUserId, 'owner-1');
      assert.equal(latestMessage, '今日の予定は？');
    },
    reviewVisitorReplyImpl: async ({ candidateReply, sources }) => {
      assert.equal(sources[0].kind, 'general');
      return { decision: 'allow', message: candidateReply };
    }
  });

  assert.match(reply, /公開カレンダーはこちらです/);
  assert.match(reply, /https:\/\/calendar\.example\.com\/public/);
  assert.equal(pendingCalls, 1);
  config.app.publicCalendarUrl = ORIGINAL_PUBLIC_CALENDAR_URL;
});

test('processLineMessage reviews unregistered visitor others replies as general answers', async () => {
  const reply = await processLineMessage({
    senderUserId: 'visitor-raw',
    ownerUserId: 'owner-1',
    senderRole: 'visitor',
    text: 'こんにちは'
  }, {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async () => ({
      text: '- 会話履歴なし'
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({ events: [] })
    }),
    classifyVisitorActionImpl: async () => ({ action: 'others', reason: 'chat' }),
    resolveVisitorIdentityImpl: async () => ({
      status: 'unregistered',
      lineUserId: 'visitor-raw',
      personId: '',
      personSummary: null,
      scopePolicy: { allowedScopes: [] }
    }),
    ensurePendingVisitorRegisteredImpl: async () => {},
    generateOthersReplyImpl: async () => 'こんにちは、どうしましたか？',
    reviewVisitorReplyImpl: async ({ candidateReply, sources }) => {
      assert.equal(sources[0].kind, 'general');
      return { decision: 'allow', message: candidateReply };
    }
  });

  assert.equal(reply, 'こんにちは、どうしましたか？');
});

test('processLineMessage returns detailed agenda with public calendar link for detail scope visitor', async () => {
  config.app.publicCalendarUrl = 'https://calendar.example.com/public';
  const reply = await processLineMessage({
    senderUserId: 'visitor-2',
    ownerUserId: 'owner-1',
    senderRole: 'visitor',
    text: '今日の予定は？'
  }, {
    getLocalDateContextImpl: () => ({
      dateKey: '2026-03-12',
      localTime: '09:00:00',
      timeZone: 'UTC'
    }),
    loadConversationContextImpl: async () => ({
      text: '- 会話履歴なし'
    }),
    createExecutionContextImpl: () => ({
      getCalendarSnapshot: async () => ({
        events: [{
          eventId: 'evt-1',
          title: '打ち合わせ',
          status: 'todo',
          allDay: false,
          startTime: '10:00:00',
          endTime: '11:00:00',
          detail: '研究進捗の確認',
          notifyOnEnd: false
        }]
      })
    }),
    classifyVisitorActionImpl: async () => ({ action: 'list_events', reason: 'read only' }),
    resolveVisitorIdentityImpl: async () => ({
      status: 'registered',
      lineUserId: 'visitor-2',
      personId: 'person-2',
      personSummary: {
        name: 'Visitor Two',
        role: 'friend',
        relationshipToOwner: 'friend'
      },
      scopePolicy: {
        allowedScopes: ['owner.today_agenda.detail']
      }
    }),
    reviewVisitorReplyImpl: async ({ candidateReply, sources }) => {
      assert.equal(sources[0].scope, 'owner.today_agenda.detail');
      return { decision: 'allow', message: candidateReply };
    }
  });

  assert.match(reply, /詳細: 研究進捗の確認/);
  assert.match(reply, /https:\/\/calendar\.example\.com\/public/);
  config.app.publicCalendarUrl = ORIGINAL_PUBLIC_CALENDAR_URL;
});
