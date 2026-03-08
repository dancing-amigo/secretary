import { randomUUID } from 'crypto';
import { config } from '../config.js';
import {
  getNotificationRecord,
  readConversationTurns,
  readSoulMarkdown,
  readUserMarkdown,
  updateNotificationRecord,
  upsertDailyLog,
  writeSoulMarkdown,
  writeUserMarkdown
} from './googleDriveState.js';
import { pullGoogleCalendarEventsForDate, reconcileAgendaEventsForDate } from './googleCalendarSync.js';
import { reconcileReminderSchedulesForDate } from './eventReminders.js';
import { createStructuredOutput, createTextOutput } from './openaiClient.js';

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reason'],
  properties: {
    action: {
      type: 'string',
      enum: ['modify_events', 'list_events', 'edit_soul', 'edit_user', 'others']
    },
    reason: { type: 'string' }
  }
};

const PROFILE_EDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'updatedContent', 'message'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['updated', 'clarify']
    },
    updatedContent: { type: 'string' },
    message: { type: 'string' }
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
        required: ['id', 'title', 'status', 'notifyOnEnd', 'detail', 'allDay', 'startTime', 'endTime'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: {
            type: 'string',
            enum: ['todo', 'done']
          },
          notifyOnEnd: { type: 'boolean' },
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

function buildActionPrompt({ text, dateKey, localTime, timeZone, conversationText, agendaContext }) {
  return [
    'あなたは個人向けLINE秘書のアクション分類器です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '次の5つから必ず1つだけ選んでください。',
    '- modify_events: ユーザーが今日の予定を追加・編集・削除・完了報告・補足更新したい意図の発話。',
    '- list_events: ユーザーが今日の予定一覧、やること一覧、行動一覧を知りたい意図の発話。',
    '- edit_soul: AIの人格・口調・振る舞い・判断方針・記憶運用として SOUL.md に反映すべき内容。明示的な編集依頼だけでなく、AIへのダメ出し、口調修正、振る舞い修正、今後の対応方針の指摘も含む。',
    '- edit_user: ユーザー属性・嗜好・前提情報・覚えておくべき事実として USER.md に反映すべき内容。明示的な編集依頼だけでなく、新しく判明した個人情報、好み、苦手、思考傾向、継続して覚えると役立つ事情も含む。',
    '- others: それ以外。雑談、あいさつ、曖昧な発話、副作用を起こすべきでない発話を含む。',
    '',
    '優先順位:',
    '- 今日の予定を変える依頼は modify_events を最優先する。',
    '- 今日の予定一覧を知りたい依頼は list_events を優先する。',
    '- 予定操作が主目的ではない場合、会話から長期的に保持すべきユーザー情報が新しく得られたら、明示的な編集依頼がなくても edit_user を積極的に選ぶ。',
    '- 予定操作が主目的ではない場合、AIの口調、姿勢、判断、気の利かせ方、確認の仕方、覚え方などに対する指摘や改善要求があれば、明示的な編集依頼がなくても edit_soul を積極的に選ぶ。',
    '- SOUL.md / USER.md についての相談、説明要求、感想確認だけで、実際に残すべき新情報や修正指示がないなら edit_* ではなく others にする。',
    '- edit_user に寄せる情報の例: ユーザーの新しいプロフィール、趣味、苦手、生活リズム、価値観、考え方、継続案件、覚えておくと今後の支援精度が上がる事実。',
    '- edit_soul に寄せる情報の例: 「もっと簡潔に」「その言い方は嫌」「勝手に決めず確認して」「今後は先に結論を言って」「そういうノリはやめて」など、AIの恒常的な振る舞い改善につながる指摘。',
    '- SOUL.md 対象なら edit_soul、USER.md 対象なら edit_user。両方に見える場合は、主に変えるべきものを選ぶ。どうしても主対象を決められない場合だけ others にする。',
    '',
    '自然な日本語として広く解釈してください。',
    '可能なら、今日の予定状況を踏まえて解釈してください。',
    'この段階では変更計画の作成はしません。',
    'JSONオブジェクトのみを返してください。',
    '',
    '当日会話履歴:',
    conversationText,
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
    .map((turn) => `- [${formatConversationTimestamp(turn.localAt)}] ${turn.role}: ${turn.text}`)
    .join('\n');
}

function formatConversationTimestamp(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:[+-]\d{2}:\d{2}|Z)?$/);
  if (!match) return normalized;
  return `${match[1]} ${match[2]}`;
}

function shiftDateKey(dateKey, days) {
  const { year, month, day } = parseLocalDateParts(dateKey);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function buildConversationWindow({ dateKey, localTime, timeZone }) {
  return {
    since: getUtcIsoForLocalDateTime({
      dateKey: shiftDateKey(dateKey, -1),
      time: '22:00:00',
      timeZone
    }),
    until: getUtcIsoForLocalDateTime({
      dateKey,
      time: localTime,
      timeZone
    })
  };
}

function buildPreviousDayConversationWindow({ dateKey, timeZone }) {
  return {
    since: getUtcIsoForLocalDateTime({
      dateKey: shiftDateKey(dateKey, -1),
      time: '00:00:00',
      timeZone
    }),
    until: getUtcIsoForLocalDateTime({
      dateKey,
      time: '00:00:00',
      timeZone
    })
  };
}

async function loadConversationContext({ userId, dateKey, localTime, timeZone }) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    throw new Error('会話履歴の取得に必要な userId がありません。');
  }

  const { since, until } = buildConversationWindow({ dateKey, localTime, timeZone });
  const turns = await readConversationTurns({ userId: normalizedUserId, since, until });

  return {
    since,
    until,
    turns,
    text: formatConversationTurns(turns)
  };
}

async function loadPreviousDayConversationContext({ userId, dateKey, timeZone }) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) {
    throw new Error('会話履歴の取得に必要な userId がありません。');
  }

  const { since, until } = buildPreviousDayConversationWindow({ dateKey, timeZone });
  const turns = await readConversationTurns({ userId: normalizedUserId, since, until });

  return {
    since,
    until,
    turns,
    text: formatConversationTurns(turns)
  };
}

function formatAgendaEventsForSummary(events) {
  if (events.length === 0) {
    return '- 予定なし';
  }

  return events
    .map((event) => {
      const detail = event.detail ? ` / ${event.detail}` : '';
      const timeText = event.allDay ? '終日' : `${event.startTime || '(start?)'}-${event.endTime || '(end?)'}`;
      const notifyText = event.notifyOnEnd ? ' / notifyOnEnd:on' : ' / notifyOnEnd:off';
      return `- [${event.status}] ${timeText} ${event.title} (id: ${event.eventId})${detail}${notifyText}`;
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
      const notifyText = event.notifyOnEnd ? 'notifyOnEnd:on' : 'notifyOnEnd:off';
      return `- [${event.status}] ${timeText} ${event.title}${detail} / ${notifyText} / eventId: ${event.eventId}`;
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
  const notifyText = event.notifyOnEnd ? ' | notifyOnEnd:on' : '';
  return `- ${timeText} | ${event.title || '(no title)'} | ${event.status || 'todo'}${notifyText}`;
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

function buildMorningGreetingPrompt({ dateKey, localTime, timeZone, conversationText, agendaText }) {
  return [
    'あなたは個人向けLINE秘書の朝メッセージ生成役です。',
    `対象日付: ${dateKey}`,
    `送信直前のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '目的:',
    '- ユーザーが朝に読みやすい、短く自然な日本語メッセージを1本だけ作る',
    '- 前日会話の文脈を踏まえつつ、今日の予定を必要に応じて自然に触れる',
    '- ユーザーの気分が少し上向くような言い方を選ぶ',
    '',
    '文面方針:',
    '- JSON ではなく、そのまま送れる完成済みの短いメッセージ本文だけを返す',
    '- 毎回同じ型や同じ言い回しに寄せすぎない。自然に少しずつ変化を出す',
    '- 挨拶、予定確認、気遣い、軽い後押しなどは必要に応じて柔軟に組み合わせる',
    '- ただし長くしすぎず、朝に一目で読める簡潔さを優先する',
    '- 予定がある日は、予定一覧の丸写しではなく重要な流れだけ短く触れる',
    '- 予定がない日は、そのことを自然に伝えるか、あえて触れなくてもよい',
    '- 前日会話に接続できるなら反映する。無理に触れない',
    '- プレッシャーが強すぎる言い方、説教調、根拠のない断定は避ける',
    '- 絵文字、見出し、箇条書き、過度な定型フォーマットは使わない',
    '',
    '前日会話履歴:',
    conversationText,
    '',
    '今日の予定一覧:',
    agendaText
  ].join('\n');
}

function buildNewAgendaEventIdCandidates(count = 10) {
  return Array.from({ length: count }, () => `draft-event-${randomUUID()}`);
}

function buildAgendaRewritePrompt({ text, dateKey, localTime, timeZone, conversationText, agendaContext, newEventIds, userId }) {
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
    '{"outcome":"updated","events":[{"id":"...","title":"...","status":"todo|done","notifyOnEnd":false,"detail":"...","allDay":true,"startTime":"","endTime":""}],"message":"..."}',
    '',
    'ルール:',
    '- 変更がない event も含めて、当日一覧の最終状態を events 配列へすべて返してください。',
    '- 既存 event を残す場合は、その id を必ずそのまま維持してください。',
    '- 新規 event を追加する場合は、下の新規 id 候補だけを使ってください。',
    '- title は短く、何の予定か分かる表現にしてください。',
    '- status は todo または done のどちらかにしてください。特に完了報告がなければ todo を使ってください。',
    '- notifyOnEnd は、終了時刻後も未完了なら通知を続けたい event のときだけ true にしてください。通常は false です。',
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
    '当日会話履歴:',
    conversationText,
    '',
    '現在の当日予定一覧:',
    agendaContext,
    '',
    'ユーザーメッセージ:',
    text
  ].join('\n');
}

function buildProfileEditPrompt({
  targetFile,
  userMessage,
  conversationText,
  soulMarkdown,
  userMarkdown,
  currentContent
}) {
  return [
    `あなたは ${targetFile} の編集実行役です。`,
    '',
    'JSON オブジェクトで返してください。',
    'outcome:',
    '- updated: 安全に更新内容を確定できる場合',
    '- clarify: 指示が曖昧で確定更新できない場合',
    'updatedContent:',
    '- updated のときは更新後ファイル全文',
    '- clarify のときは空文字でよい',
    'message:',
    '- updated のときは、対象ファイル名と主な変更点を短く伝える完成済みの返信文',
    '- clarify のときは、確認したい内容を短い日本語で伝える',
    '',
    'ルール:',
    `- 更新対象は ${targetFile} だけです。もう片方のファイルは変更しません。`,
    '- 最新メッセージに明示的な「更新して」がなくても、会話からこのファイルに残すべき新情報や修正方針が具体的に読み取れるなら反映してください。',
    `- ${targetFile === 'USER.md'
      ? 'USER.md には、今後の支援に継続的に役立つユーザー情報を残してください。プロフィール、好み、苦手、思考傾向、習慣、制約、重要な予定外コンテキスト、覚えておくべき事実を優先します。'
      : 'SOUL.md には、今後の応答や行動に継続的に効くAI側のルールだけを残してください。口調、距離感、説明の仕方、確認の仕方、判断姿勢、先回りの仕方などを優先します。'}`,
    `- ${targetFile === 'USER.md'
      ? '一時的で再利用価値の低い発話や、その場限りの雑談は残さないでください。'
      : '一時的な謝罪文や単発の返答案ではなく、将来も使うべき恒常ルールとして整理してください。'}`,
    '- 現在の内容をベースに必要箇所だけを編集し、無関係な削除や全面的な書き換えは避けてください。',
    '- Markdown として自然な構成を保ってください。',
    '- 依頼が質問止まり、相談止まり、感想確認だけ、または変更内容が特定できない場合は clarify にしてください。',
    '- message は長文化しすぎず、そのままLINEで返せる文面にしてください。',
    '',
    `[現在の ${targetFile}]`,
    currentContent,
    '',
    '[参考: SOUL.md]',
    soulMarkdown,
    '',
    '[参考: USER.md]',
    userMarkdown,
    '',
    '当日会話履歴:',
    conversationText,
    '',
    '最新のユーザー依頼:',
    userMessage
  ].join('\n');
}

async function classifyAction({ text, dateContext, conversationContext, agendaContext }) {
  return createStructuredOutput({
    model: config.openai.actionModel,
    schemaName: 'action_plan',
    schema: ACTION_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildActionPrompt({ text, ...dateContext, conversationText: conversationContext.text, agendaContext })
  });
}

async function rewriteAgendaEvents({ text, dateContext, conversationContext, agendaContext, newEventIds, userId }) {
  return createStructuredOutput({
    model: config.openai.taskModel,
    schemaName: 'agenda_rewrite',
    schema: AGENDA_REWRITE_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildAgendaRewritePrompt({
      text,
      ...dateContext,
      conversationText: conversationContext.text,
      agendaContext,
      newEventIds,
      userId
    })
  });
}

async function editProfileFile({
  targetFile,
  text,
  conversationContext,
  soulMarkdown,
  userMarkdown
}) {
  const currentContent = targetFile === 'SOUL.md' ? soulMarkdown : userMarkdown;
  return createStructuredOutput({
    model: config.openai.taskModel,
    schemaName: targetFile === 'SOUL.md' ? 'edit_soul_result' : 'edit_user_result',
    schema: PROFILE_EDIT_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildProfileEditPrompt({
      targetFile,
      userMessage: text,
      conversationText: conversationContext.text,
      soulMarkdown,
      userMarkdown,
      currentContent
    })
  });
}

function normalizeProfileEditContent(content) {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .trim()
    .concat('\n');
}

async function generateNightSummary({ dateKey, localTime, timeZone, conversationContext, events }) {
  const raw = await createStructuredOutput({
    model: config.openai.summaryModel || config.openai.taskModel,
    schemaName: 'night_summary',
    schema: NIGHT_SUMMARY_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildNightSummaryPrompt({
      dateKey,
      localTime,
      timeZone,
      conversationText: conversationContext.text,
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

function normalizeMorningMessage(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, 5000);

  return normalized || 'ボス、おはようございます！今日も元気に頑張っていきましょう！';
}

async function generateMorningGreeting({ dateKey, localTime, timeZone, conversationContext, events }) {
  const text = await createTextOutput({
    model: config.openai.summaryModel || config.openai.taskModel,
    systemPrompt: '完成済みの日本語メッセージ本文だけを返してください。前置きや説明は不要です。',
    userPrompt: buildMorningGreetingPrompt({
      dateKey,
      localTime,
      timeZone,
      conversationText: conversationContext.text,
      agendaText: formatAgendaEventsForSummary(events)
    })
  });

  return {
    messageText: normalizeMorningMessage(text)
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
    const notifyOnEnd = Boolean(rawEvent.notifyOnEnd);
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
      notifyOnEnd,
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
  const conversationContext = await loadConversationContext({ userId, ...dateContext });
  const executionContext = createExecutionContext(dateContext);
  const calendarSnapshot = await executionContext.getCalendarSnapshot('line_message');
  const agendaContext = formatAgendaContext(calendarSnapshot);

  const actionPlan = await classifyAction({ text: rawText, dateContext, conversationContext, agendaContext });

  if (actionPlan.action === 'modify_events') {
    const currentEvents = Array.isArray(calendarSnapshot.events) ? calendarSnapshot.events : [];
    const currentEventsById = new Map(currentEvents.map((event) => [String(event.eventId || '').trim(), event]));
    const newEventIds = buildNewAgendaEventIdCandidates();
    const rewriteResult = await rewriteAgendaEvents({
      text: rawText,
      dateContext,
      conversationContext,
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

    try {
      const latestCalendarSnapshot = await pullGoogleCalendarEventsForDate({
        dateKey: dateContext.dateKey,
        operation: 'event_reminder_reconcile'
      });
      if (!latestCalendarSnapshot.failed) {
        await reconcileReminderSchedulesForDate({
          dateKey: dateContext.dateKey,
          events: latestCalendarSnapshot.events
        });
      }
    } catch (error) {
      console.error('[event-reminders] reconcile failed', {
        dateKey: dateContext.dateKey,
        error: String(error?.message || error)
      });
    }

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

  if (actionPlan.action === 'edit_soul' || actionPlan.action === 'edit_user') {
    const [soulMarkdown, userMarkdown] = await Promise.all([
      readSoulMarkdown(),
      readUserMarkdown()
    ]);
    const targetFile = actionPlan.action === 'edit_soul' ? 'SOUL.md' : 'USER.md';
    const editResult = await editProfileFile({
      targetFile,
      text: rawText,
      conversationContext,
      soulMarkdown,
      userMarkdown
    });

    if (editResult.outcome === 'clarify') {
      return String(editResult.message || '').trim() || `${targetFile} のどこを変えるか確認させてください。`;
    }

    const updatedContent = normalizeProfileEditContent(editResult.updatedContent);
    if (targetFile === 'SOUL.md') {
      await writeSoulMarkdown(updatedContent);
    } else {
      await writeUserMarkdown(updatedContent);
    }

    return String(editResult.message || '').trim() || `${targetFile} を更新しました。`;
  }

  if (actionPlan.action === 'others') {
    return 'OK';
  }

  throw new Error('アクション判定に失敗しました。もう一度送ってください。');
}

export async function runMorningPlan() {
  const dateContext = getLocalDateContext();
  const executionContext = createExecutionContext(dateContext);
  const conversationContext = await loadPreviousDayConversationContext({
    userId: config.line.defaultUserId,
    dateKey: dateContext.dateKey,
    timeZone: dateContext.timeZone
  });
  const calendarSnapshot = await executionContext.getCalendarSnapshot('morning_plan');
  const greeting = await generateMorningGreeting({
    dateKey: dateContext.dateKey,
    localTime: dateContext.localTime,
    timeZone: dateContext.timeZone,
    conversationContext,
    events: Array.isArray(calendarSnapshot.events) ? calendarSnapshot.events : []
  });
  return greeting.messageText;
}

export async function prepareNightReview({ userId, dateKey, localTime, timeZone = config.tz }) {
  const conversationContext = await loadConversationContext({ userId, dateKey, localTime, timeZone });
  const executionContext = createExecutionContext({ dateKey, localTime, timeZone });
  const calendarSnapshot = await executionContext.getCalendarSnapshot('night_review');
  const existing = await getNotificationRecord({ slot: 'night', dateKey });
  const events = Array.isArray(calendarSnapshot.events) ? calendarSnapshot.events : [];
  const summary = await generateNightSummary({
    dateKey,
    localTime,
    timeZone,
    conversationContext,
    events,
  });

  await updateNotificationRecord({
    slot: 'night',
    dateKey,
    updates: {
      summaryGeneratedAt: new Date().toISOString(),
      summarySource: {
        since: conversationContext.since,
        until: conversationContext.until,
        conversationCount: conversationContext.turns.length,
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
