import { randomUUID } from 'crypto';
import { config } from '../config.js';
import {
  getLatestSentNotificationBefore,
  getNotificationRecord,
  readConversationTurns,
  updateNotificationRecord,
  upsertDailyLog
} from './googleDriveState.js';
import { pullGoogleCalendarEventsForDate, reconcileAgendaEventsForDate } from './googleCalendarSync.js';
import { createStructuredOutput } from './openaiClient.js';

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reason'],
  properties: {
    action: {
      type: 'string',
      enum: ['modify_events', 'list_events', 'others']
    },
    reason: { type: 'string' }
  }
};

const NIGHT_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['extraNotes'],
  properties: {
    extraNotes: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};

const AGENDA_REWRITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'events', 'message'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['updated', 'clarify']
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'status', 'detail', 'allDay', 'startTime', 'endTime'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: {
            type: 'string',
            enum: ['todo', 'done']
          },
          detail: { type: 'string' },
          allDay: { type: 'boolean' },
          startTime: { type: 'string' },
          endTime: { type: 'string' }
        }
      }
    },
    message: { type: 'string' }
  }
};

function getLocalDateContext(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
  const localTime = `${get('hour')}:${get('minute')}:${get('second')}`;

  return {
    dateKey,
    localTime,
    timeZone: config.tz
  };
}

function buildActionPrompt({ text, dateKey, localTime, timeZone, agendaContext }) {
  return [
    'あなたは個人向けLINE秘書のアクション分類器です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '次の3つから必ず1つだけ選んでください。',
    '- modify_events: ユーザーが今日の予定を追加・編集・削除・完了報告・補足更新したい意図の発話。',
    '- list_events: ユーザーが今日の予定一覧、やること一覧、行動一覧を知りたい意図の発話。',
    '- others: それ以外。雑談、あいさつ、曖昧な発話、副作用を起こすべきでない発話を含む。',
    '',
    '自然な日本語として広く解釈してください。',
    '可能なら、今日の予定状況を踏まえて解釈してください。',
    'この段階では変更計画の作成はしません。',
    'JSONオブジェクトのみを返してください。',
    '',
    '今日の予定一覧:',
    agendaContext,
    '',
    'ユーザーメッセージ:',
    text
  ].join('\n');
}

function getTimeZoneOffsetMinutes(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    hour: '2-digit'
  }).formatToParts(date);
  const rawOffset = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = rawOffset.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  return sign * (hours * 60 + minutes);
}

function parseLocalDateParts(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new RangeError(`Invalid local date: ${dateKey}`);
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function parseLocalTimeParts(time) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new RangeError(`Invalid local time: ${time}`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError(`Invalid local time: ${time}`);
  }

  return { hour, minute, second };
}

export function getUtcIsoForLocalDateTime({ dateKey, time, timeZone }) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const { hour, minute, second } = parseLocalTimeParts(time);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = getTimeZoneOffsetMinutes(timeZone, utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000).toISOString();
}

function formatConversationTurns(turns) {
  if (turns.length === 0) {
    return '- 会話履歴なし';
  }

  return turns
    .map((turn) => `- [${turn.at}] ${turn.role}: ${turn.text}`)
    .join('\n');
}

function formatAgendaEventsForSummary(events) {
  if (events.length === 0) {
    return '- 予定なし';
  }

  return events
    .map((event) => {
      const detail = event.detail ? ` / ${event.detail}` : '';
      const timeText = event.allDay ? '終日' : `${event.startTime || '(start?)'}-${event.endTime || '(end?)'}`;
      return `- [${event.status}] ${timeText} ${event.title} (id: ${event.eventId})${detail}`;
    })
    .join('\n');
}

function formatCalendarEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return '- 予定なし';
  }

  return events
    .map((event) => {
      const timeText = event.allDay ? '終日' : `${event.startTime || '(start?)'}-${event.endTime || '(end?)'}`;
      const detail = event.detail ? ` / ${event.detail}` : '';
      return `- [${event.status}] ${timeText} ${event.title}${detail} / eventId: ${event.eventId}`;
    })
    .join('\n');
}

function formatAgendaContext(calendarSnapshot) {
  if (!calendarSnapshot?.enabled) {
    return '- カレンダー同期は無効です';
  }

  if (calendarSnapshot.failed) {
    return `- カレンダー取得失敗: ${String(calendarSnapshot.error || 'unknown error')}`;
  }

  const header = [
    `- calendarId: ${calendarSnapshot.calendarId || '(unknown)'}`,
    `- 対象日付: ${calendarSnapshot.dateKey || '(unknown)'}`,
    `- 取得期間: ${calendarSnapshot.windowStart || '(unknown)'} -> ${calendarSnapshot.windowEnd || '(unknown)'}`
  ];

  return [...header, formatCalendarEvents(calendarSnapshot.events)].join('\n');
}

function normalizeSummaryList(items) {
  return Array.isArray(items)
    ? items.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : [];
}

function formatEventLine(event) {
  const timeText = event.allDay
    ? 'All day'
    : `${formatAgendaTimeForDisplay(event.startTime) || '(start?)'}-${formatAgendaTimeForDisplay(event.endTime) || '(end?)'}`;
  return `- ${timeText} | ${event.title || '(no title)'} | ${event.status || 'todo'}`;
}

function formatNightSummaryMessage({ events, extraNotes }) {
  const lines = ['今日のイベント一覧です。', '', '【Events】'];
  lines.push(...(events.length > 0 ? events.map((event) => formatEventLine(event)) : ['- 予定なし']));

  if (extraNotes.length > 0) {
    lines.push('', '【補足メモ】');
    lines.push(...extraNotes.map((item) => `- ${item}`));
  }

  return lines.join('\n').slice(0, 5000);
}

function formatNightSummaryLog({ events, extraNotes, calendarSyncError }) {
  return [
    '### Events',
    ...(events.length > 0 ? events.map((event) => formatEventLine(event)) : ['- 予定なし']),
    '',
    '### 補足メモ',
    ...(calendarSyncError ? [`- カレンダー同期失敗: ${calendarSyncError}`] : []),
    ...(extraNotes.length > 0 ? extraNotes.map((item) => `- ${item}`) : calendarSyncError ? [] : ['- 特記事項なし'])
  ].join('\n');
}

function buildNightSummaryPrompt({ dateKey, localTime, timeZone, conversationText, agendaText }) {
  return [
    'あなたは個人向けLINE秘書の日次サマリー生成役です。',
    `対象日付: ${dateKey}`,
    `送信直前のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '目的:',
    '- event 一覧そのものは別途固定フォーマットで保存するので、ここでは会話履歴からしか取れない補足情報だけを抽出する',
    '- 予定の追加、削除、変更、完了が event 一覧を見れば分かる場合は繰り返さない',
    '',
    '出力ルール:',
    '- extraNotes だけを返す',
    '- extraNotes には、会話から読み取れる重要な制約、背景、注意事項、翌日以降にも効くメモだけを書く',
    '- event の title, time, status を書き直さない',
    '- 該当がなければ空配列にする',
    '- 各配列要素は短い日本語の 1 文で書く',
    '- 根拠のない推測は避ける',
    '',
    '会話履歴:',
    conversationText,
    '',
    '当日の予定一覧:',
    agendaText
  ].join('\n');
}

function buildNewAgendaEventIdCandidates(count = 10) {
  return Array.from({ length: count }, () => `draft-event-${randomUUID()}`);
}

function buildAgendaRewritePrompt({ text, dateKey, localTime, timeZone, agendaContext, newEventIds, userId }) {
  return [
    'あなたは今日の Google Calendar event 一覧の最終状態とLINE返信文を同時に作る役割です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    'JSON オブジェクトで返してください。',
    'outcome:',
    '- updated: 安全に更新できる場合',
    '- clarify: 対象が曖昧で安全に更新できない場合',
    'events:',
    '- updated のときは、その日の最終的な event 一覧を配列で返してください',
    '- clarify のときは空配列でよい',
    'message:',
    '- updated のときは、LINE に送る変更完了メッセージ',
    '- clarify のときは、確認したい内容を短い日本語で返す',
    '',
    '出力フォーマット:',
    '{"outcome":"updated","events":[{"id":"...","title":"...","status":"todo|done","detail":"...","allDay":true,"startTime":"","endTime":""}],"message":"..."}',
    '',
    'ルール:',
    '- 変更がない event も含めて、当日一覧の最終状態を events 配列へすべて返してください。',
    '- 既存 event を残す場合は、その id を必ずそのまま維持してください。',
    '- 新規 event を追加する場合は、下の新規 id 候補だけを使ってください。',
    '- title は短く、何の予定か分かる表現にしてください。',
    '- status は todo または done のどちらかにしてください。特に完了報告がなければ todo を使ってください。',
    '- detail には補足、条件、場所、制約などを簡潔に要約してください。不要なら空文字にしてください。',
    '- allDay が true のとき startTime と endTime は空文字にしてください。',
    '- allDay が false のとき startTime と endTime は HH:MM:SS 形式にしてください。',
    '- 削除指示があれば、その event は events 配列から除外してください。',
    '- 既存の会議や予定も、ユーザー意図に合うなら編集・削除して構いません。',
    '- 配列順は自然でよいですが、残す event の内容を勝手に落とさないでください。',
    '- message には、何を追加・完了・更新・削除したかを簡潔に書いてください。',
    '- message は自然なLINEメッセージとして、そのまま送れる形にしてください。',
    '',
    `現在のユーザーID: ${userId || '(empty)'}`,
    '新規 event 用の id 候補:',
    ...newEventIds.map((id) => `- ${id}`),
    '',
    '現在の当日予定一覧:',
    agendaContext,
    '',
    'ユーザーメッセージ:',
    text
  ].join('\n');
}

async function classifyAction({ text, dateContext, agendaContext }) {
  return createStructuredOutput({
    model: config.openai.actionModel,
    schemaName: 'action_plan',
    schema: ACTION_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildActionPrompt({ text, ...dateContext, agendaContext })
  });
}

async function rewriteAgendaEvents({ text, dateContext, agendaContext, newEventIds, userId }) {
  return createStructuredOutput({
    model: config.openai.taskModel,
    schemaName: 'agenda_rewrite',
    schema: AGENDA_REWRITE_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildAgendaRewritePrompt({ text, ...dateContext, agendaContext, newEventIds, userId })
  });
}

async function generateNightSummary({ dateKey, localTime, timeZone, userId, turns, events, since, until }) {
  const raw = await createStructuredOutput({
    model: config.openai.summaryModel || config.openai.taskModel,
    schemaName: 'night_summary',
    schema: NIGHT_SUMMARY_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildNightSummaryPrompt({
      dateKey,
      localTime,
      timeZone,
      conversationText: formatConversationTurns(turns),
      agendaText: formatAgendaEventsForSummary(events)
    })
  });

  const extraNotes = normalizeSummaryList(raw.extraNotes);

  return {
    extraNotes,
    messageText: formatNightSummaryMessage({ events, extraNotes }),
    logEntryMarkdown: formatNightSummaryLog({
      events,
      extraNotes
    })
  };
}

function formatAgendaList(events) {
  if (events.length === 0) {
    return '今日の予定はありません。';
  }

  const lines = ['今日の予定です。'];
  for (const event of events) {
    const prefix = event.allDay
      ? '終日'
      : `${formatAgendaTimeForDisplay(event.startTime) || '(start?)'}-${formatAgendaTimeForDisplay(event.endTime) || '(end?)'}`;
    lines.push(`${prefix} [${event.status}]`);
    lines.push(event.title);
    lines.push('');
  }

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

function formatAgendaTimeForDisplay(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) return normalized;
  return `${match[1]}:${match[2]}`;
}

function normalizeFullTimeString(value) {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function normalizeAgendaEventStatus(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'done') return 'done';
  if (raw === 'todo') return 'todo';
  return 'todo';
}

function normalizeAgendaEventsFromModel(events, allowedNewEventIds, currentEventsById) {
  const allowedNewIds = new Set(allowedNewEventIds);
  const normalized = [];
  const seenIds = new Set();

  for (const rawEvent of Array.isArray(events) ? events : []) {
    const eventId = String(rawEvent?.id || '').trim();
    if (!eventId || seenIds.has(eventId)) {
      throw new Error('返却された event 一覧に不正な id があります。');
    }
    seenIds.add(eventId);

    const status = normalizeAgendaEventStatus(rawEvent.status);
    const title = String(rawEvent.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!title) {
      throw new Error('event title は必須です。');
    }

    const detail = String(rawEvent.detail || '').trim().replace(/\s+/g, ' ').slice(0, 280);
    const allDay = Boolean(rawEvent.allDay);
    const startTime = allDay ? '' : normalizeFullTimeString(rawEvent.startTime);
    const endTime = allDay ? '' : normalizeFullTimeString(rawEvent.endTime);
    if (!allDay && (!startTime || !endTime || startTime >= endTime)) {
      throw new Error('時間付き event の startTime/endTime が不正です。');
    }

    const existing = currentEventsById.get(eventId);
    if (!existing && !allowedNewIds.has(eventId)) {
      throw new Error('新規 event の id が許可された候補に含まれていません。');
    }

    normalized.push({
      eventId,
      title,
      status,
      detail,
      allDay,
      startTime,
      endTime
    });
  }

  return normalized;
}

export async function processUserMessage({ userId, text }) {
  const rawText = String(text || '').trim();
  if (!rawText) {
    return 'OK';
  }

  const dateContext = getLocalDateContext();
  const executionContext = createExecutionContext(dateContext);
  const calendarSnapshot = await executionContext.getCalendarSnapshot('line_message');
  const agendaContext = formatAgendaContext(calendarSnapshot);

  const actionPlan = await classifyAction({ text: rawText, dateContext, agendaContext });

  if (actionPlan.action === 'modify_events') {
    const currentEvents = Array.isArray(calendarSnapshot.events) ? calendarSnapshot.events : [];
    const currentEventsById = new Map(currentEvents.map((event) => [String(event.eventId || '').trim(), event]));
    const newEventIds = buildNewAgendaEventIdCandidates();
    const rewriteResult = await rewriteAgendaEvents({
      text: rawText,
      dateContext,
      userId,
      agendaContext,
      newEventIds
    });

    if (rewriteResult.outcome === 'clarify') {
      return String(rewriteResult.message || '').trim() || 'どの予定を更新するか確認させてください。';
    }

    const nextEvents = normalizeAgendaEventsFromModel(
      rewriteResult.events,
      newEventIds,
      currentEventsById
    );

    const calendarSyncResult = await reconcileAgendaEventsForDate({
      dateKey: dateContext.dateKey,
      currentEvents,
      nextEvents,
      allowedNewEventIds: newEventIds
    });
    const syncResult = {
      enabled: calendarSyncResult.enabled,
      failed: calendarSyncResult.failed,
      retryable: calendarSyncResult.retryable
    };

    const baseMessage = String(rewriteResult.message || '').trim() || '今日の予定を更新しました。';
    if (!syncResult.enabled || syncResult.failed === 0) {
      return baseMessage;
    }

    if (syncResult.retryable > 0) {
      return `${baseMessage}（Google同期で一部再試行予定）`;
    }

    return `${baseMessage}（Google同期で一部失敗）`;
  }

  if (actionPlan.action === 'list_events') {
    return formatAgendaList(Array.isArray(calendarSnapshot.events) ? calendarSnapshot.events : []);
  }

  if (actionPlan.action === 'others') {
    return 'OK';
  }

  throw new Error('アクション判定に失敗しました。もう一度送ってください。');
}

export async function runMorningPlan() {
  const dateContext = getLocalDateContext();
  const executionContext = createExecutionContext(dateContext);
  await executionContext.getCalendarSnapshot('morning_plan');
  return '朝です';
}

export async function prepareNightReview({ userId, dateKey, localTime, timeZone = config.tz }) {
  const executionContext = createExecutionContext({ dateKey, localTime, timeZone });
  const calendarSnapshot = await executionContext.getCalendarSnapshot('night_review');
  const existing = await getNotificationRecord({ slot: 'night', dateKey });
  if (existing?.sentAt) {
    return {
      text: '',
      alreadySent: true,
      reusedSummary: false,
      logUpdated: Boolean(existing.logUpdatedAt)
    };
  }

  const previousSummary = await getLatestSentNotificationBefore({ slot: 'night', dateKey });
  const since = previousSummary?.sentAt || getUtcIsoForLocalDateTime({
    dateKey,
    time: '00:00:00',
    timeZone
  });
  const until = getUtcIsoForLocalDateTime({
    dateKey,
    time: localTime,
    timeZone
  });
  const turns = await readConversationTurns({ userId, since, until });
  const events = Array.isArray(calendarSnapshot.events) ? calendarSnapshot.events : [];
  const summary = await generateNightSummary({
    dateKey,
    localTime,
    timeZone,
    userId,
    turns,
    events,
    since,
    until
  });

  await updateNotificationRecord({
    slot: 'night',
    dateKey,
    updates: {
      summaryGeneratedAt: new Date().toISOString(),
      summarySource: {
        since,
        until,
        conversationCount: turns.length,
        eventCount: events.length
      }
    }
  });

  if (!existing?.logUpdatedAt) {
    await upsertDailyLog({
      dateKey,
      entryMarkdown: formatNightSummaryLog({
        events,
        extraNotes: summary.extraNotes,
        calendarSyncError: calendarSnapshot.failed ? String(calendarSnapshot.error || 'unknown error') : ''
      })
    });
    await updateNotificationRecord({
      slot: 'night',
      dateKey,
      updates: {
        logUpdatedAt: new Date().toISOString()
      }
    });
  }

  return {
    text: summary.messageText || '今日のサマリーを作成できませんでした。',
    alreadySent: false,
    reusedSummary: false,
    logUpdated: true
  };
}

export async function runNightReview() {
  const dateContext = getLocalDateContext();
  const review = await prepareNightReview({
    userId: config.line.defaultUserId,
    dateKey: dateContext.dateKey,
    localTime: dateContext.localTime,
    timeZone: dateContext.timeZone
  });
  return review.text;
}

function createExecutionContext(dateContext) {
  let calendarSnapshotPromise = null;

  return {
    async getCalendarSnapshot(operation) {
      if (!calendarSnapshotPromise) {
        calendarSnapshotPromise = pullGoogleCalendarEventsForDate({
          dateKey: dateContext.dateKey,
          operation
        });
      }
      return calendarSnapshotPromise;
    }
  };
}
