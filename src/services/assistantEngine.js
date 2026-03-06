import { randomUUID } from 'crypto';
import { config } from '../config.js';
import {
  getLatestSentNotificationBefore,
  getNotificationRecord,
  readConversationTurns,
  readTaskFileForDate,
  readTasksForDate,
  replaceTaskFileForDate,
  updateNotificationRecord,
  upsertDailyLog
} from './googleDriveState.js';
import { createStructuredOutput, createTextOutput } from './openaiClient.js';

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reason'],
  properties: {
    action: {
      type: 'string',
      enum: ['modify_tasks', 'list_tasks', 'others']
    },
    reason: { type: 'string' }
  }
};

const NIGHT_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'completed', 'carryingOver', 'contextNotes', 'insights'],
  properties: {
    overview: { type: 'string' },
    completed: {
      type: 'array',
      items: { type: 'string' }
    },
    carryingOver: {
      type: 'array',
      items: { type: 'string' }
    },
    contextNotes: {
      type: 'array',
      items: { type: 'string' }
    },
    insights: {
      type: 'array',
      items: { type: 'string' }
    }
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

function buildActionPrompt({ text, dateKey, localTime, timeZone, taskContext }) {
  return [
    'あなたは個人向けLINE秘書のアクション分類器です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '次の3つから必ず1つだけ選んでください。',
    '- modify_tasks: ユーザーが今日のタスクを追加・編集・削除・完了報告・補足更新したい意図の発話。',
    '- list_tasks: ユーザーが今日のタスク一覧を知りたい、確認したい意図の発話。',
    '- others: それ以外。雑談、あいさつ、曖昧な発話、副作用を起こすべきでない発話を含む。',
    '',
    '自然な日本語として広く解釈してください。',
    '可能なら、今日のタスク状況を踏まえて解釈してください。',
    'この段階では変更計画の作成はしません。',
    'JSONオブジェクトのみを返してください。',
    '',
    '今日のタスク情報:',
    taskContext,
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

function getUtcIsoForLocalDateTime({ dateKey, time, timeZone }) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map((value) => Number(value || 0));
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

function formatTasksForSummary(tasks) {
  if (tasks.length === 0) {
    return '- タスクなし';
  }

  return tasks
    .map((task) => {
      const detail = task.detail ? ` / ${task.detail}` : '';
      return `- [${task.status}] ${task.title} (id: ${task.id})${detail}`;
    })
    .join('\n');
}

function normalizeSummaryList(items) {
  return Array.isArray(items)
    ? items.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : [];
}

function formatNightSummaryMessage(summary) {
  const lines = ['今日のサマリーです。'];
  if (summary.overview) {
    lines.push(summary.overview.trim());
  }

  lines.push('', '【完了したこと】');
  lines.push(...(summary.completed.length > 0 ? summary.completed.map((item) => `- ${item}`) : ['- 特記事項なし']));

  lines.push('', '【持ち越し・未完了】');
  lines.push(...(summary.carryingOver.length > 0 ? summary.carryingOver.map((item) => `- ${item}`) : ['- 特記事項なし']));

  lines.push('', '【メモ】');
  lines.push(...(summary.contextNotes.length > 0 ? summary.contextNotes.map((item) => `- ${item}`) : ['- 特記事項なし']));

  return lines.join('\n').slice(0, 5000);
}

function formatNightSummaryLog(summary, metadata) {
  const sections = [
    `- 送信対象ユーザー: ${metadata.userId || '(unknown)'}`,
    `- 会話対象期間: ${metadata.since} -> ${metadata.until}`,
    `- 対象会話数: ${metadata.conversationCount}`,
    `- 当日タスク数: ${metadata.taskCount}`
  ];

  return [
    '### 今日やったこと',
    ...(summary.completed.length > 0 ? summary.completed.map((item) => `- ${item}`) : ['- 特記事項なし']),
    '',
    '### できなかったこと・継続事項',
    ...(summary.carryingOver.length > 0 ? summary.carryingOver.map((item) => `- ${item}`) : ['- 特記事項なし']),
    '',
    '### ユーザー情報メモ',
    ...(summary.contextNotes.length > 0 ? summary.contextNotes.map((item) => `- ${item}`) : ['- 特記事項なし']),
    '',
    '### 次回提案に使える示唆',
    ...(summary.insights.length > 0 ? summary.insights.map((item) => `- ${item}`) : ['- 特記事項なし']),
    '',
    '### 概要',
    summary.overview || '特記事項なし',
    '',
    '### メタデータ',
    ...sections
  ].join('\n');
}

function buildNightSummaryPrompt({ dateKey, localTime, timeZone, conversationText, taskText }) {
  return [
    'あなたは個人向けLINE秘書の日次サマリー生成役です。',
    `対象日付: ${dateKey}`,
    `送信直前のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '目的:',
    '- その日の完了事項、持ち越し、進捗、制約、生活文脈を短く要約する',
    '- 単なる羅列ではなく、次回の提案や見積もりに使える具体性を残す',
    '',
    '出力ルール:',
    '- overview は 1-2 文の短い要約',
    '- completed は完了したこと、進んだこと',
    '- carryingOver は未完了、保留、持ち越し',
    '- contextNotes は時間、移動、制約、優先度、依頼背景などの文脈',
    '- insights は次回の提案に使える示唆',
    '- 各配列要素は短い日本語の 1 文で書く',
    '- 根拠のない推測は避ける',
    '',
    '会話履歴:',
    conversationText,
    '',
    '当日タスク:',
    taskText
  ].join('\n');
}

function buildNewTaskIdCandidates(count = 5) {
  return Array.from({ length: count }, () => `task-${randomUUID()}`);
}

function buildTaskRewritePrompt({ text, dateKey, localTime, timeZone, fileContent, newTaskIds, userId }) {
  return [
    'あなたは今日のタスクファイル全文を更新する役割です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    'あなたの出力は、そのまま tasks/YYYY-MM-DD.md に書き込まれます。',
    '説明文やコードフェンスは付けず、最終的な Markdown 本文だけを返してください。',
    '曖昧で安全に更新できない場合のみ、Markdown の代わりに 1 行で "CLARIFY: ..." を返してください。',
    '',
    '出力フォーマット:',
    `# Tasks ${dateKey}`,
    '',
    '## Items',
    '- [todo|done] タスクタイトル',
    '  - id: task-...',
    '  - userId: USER_ID',
    '  - detail: 補足情報',
    '',
    'ルール:',
    '- 変更がないタスクも含めて、当日ファイルの最終状態を全文で返してください。',
    '- 既存タスクを残す場合は、その id と userId を必ずそのまま維持してください。',
    '- 新規タスクを追加する場合は、下の新規 id 候補だけを使ってください。',
    '- 新規タスクの userId は必ず現在のユーザーIDを使ってください。',
    '- title は短く、行動が分かる表現にしてください。',
    '- detail には時間、条件、補足、制約のみを簡潔に要約してください。不要なら detail 行を省略して構いません。',
    '- 完了報告は status を done にしてください。',
    '- 削除指示があれば、そのタスクは最終ファイルから除外してください。',
    '- タスクが 0 件なら、Items セクションには "- まだタスクはありません" の 1 行だけを書いてください。',
    '- タスクの並び順は自然でよいですが、残すタスクの内容を勝手に落とさないでください。',
    '',
    `現在のユーザーID: ${userId || '(empty)'}`,
    '新規タスク用の id 候補:',
    ...newTaskIds.map((id) => `- ${id}`),
    '',
    '現在のファイル内容:',
    fileContent,
    '',
    'ユーザーメッセージ:',
    text
  ].join('\n');
}

async function classifyAction({ text, dateContext, taskContext }) {
  return createStructuredOutput({
    model: config.openai.actionModel,
    schemaName: 'action_plan',
    schema: ACTION_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildActionPrompt({ text, ...dateContext, taskContext })
  });
}

async function rewriteTaskFile({ text, dateContext, fileContent, newTaskIds, userId }) {
  return createTextOutput({
    model: config.openai.taskModel,
    systemPrompt: '指定された形式の Markdown 本文だけ、または "CLARIFY: ..." の 1 行だけを返してください。',
    userPrompt: buildTaskRewritePrompt({ text, ...dateContext, fileContent, newTaskIds, userId })
  });
}

async function generateNightSummary({ dateKey, localTime, timeZone, userId, turns, tasks, since, until }) {
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
      taskText: formatTasksForSummary(tasks)
    })
  });

  const summary = {
    overview: String(raw.overview || '').trim(),
    completed: normalizeSummaryList(raw.completed),
    carryingOver: normalizeSummaryList(raw.carryingOver),
    contextNotes: normalizeSummaryList(raw.contextNotes),
    insights: normalizeSummaryList(raw.insights)
  };

  return {
    ...summary,
    messageText: formatNightSummaryMessage(summary),
    logEntryMarkdown: formatNightSummaryLog(summary, {
      userId,
      since,
      until,
      conversationCount: turns.length,
      taskCount: tasks.length
    })
  };
}

function formatTaskList(tasks) {
  if (tasks.length === 0) {
    return '今日のタスクはありません。';
  }

  const lines = ['今日のタスクです。'];
  for (const [index, task] of tasks.entries()) {
    const statusLabel = task.status === 'done' ? 'done' : 'todo';
    lines.push(`${index + 1}. [${statusLabel}] ${task.title}`);
  }

  return lines.join('\n');
}

export async function processUserMessage({ userId, text }) {
  const rawText = String(text || '').trim();
  if (!rawText) {
    return 'OK';
  }

  const dateContext = getLocalDateContext();
  let taskContext = '今日のタスク情報は取得できませんでした。タスク文脈なしで判断してください。';
  try {
    taskContext = await readTaskFileForDate(dateContext.dateKey);
  } catch {}

  const actionPlan = await classifyAction({ text: rawText, dateContext, taskContext });

  if (actionPlan.action === 'modify_tasks') {
    const currentFileContent = await readTaskFileForDate(dateContext.dateKey);
    const newTaskIds = buildNewTaskIdCandidates();
    const rewrittenContent = (await rewriteTaskFile({
      text: rawText,
      dateContext,
      userId,
      fileContent: currentFileContent,
      newTaskIds
    })).trim();

    if (rewrittenContent.startsWith('CLARIFY:')) {
      return rewrittenContent.slice('CLARIFY:'.length).trim() || 'どのタスクを更新するか確認させてください。';
    }

    await replaceTaskFileForDate({
      dateKey: dateContext.dateKey,
      content: rewrittenContent,
      allowedNewTaskIds: newTaskIds,
      currentUserId: userId
    });

    return '今日のタスクを更新しました。';
  }

  if (actionPlan.action === 'list_tasks') {
    const tasks = await readTasksForDate(dateContext.dateKey);
    return formatTaskList(tasks);
  }

  if (actionPlan.action === 'others') {
    return 'OK';
  }

  throw new Error('アクション判定に失敗しました。もう一度送ってください。');
}

export async function runMorningPlan() {
  return '朝です';
}

export async function prepareNightReview({ userId, dateKey, localTime, timeZone = config.tz }) {
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
  const tasks = await readTasksForDate(dateKey);
  const summary = await generateNightSummary({
    dateKey,
    localTime,
    timeZone,
    userId,
    turns,
    tasks,
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
        taskCount: tasks.length
      }
    }
  });

  if (!existing?.logUpdatedAt) {
    await upsertDailyLog({
      dateKey,
      entryMarkdown: summary.logEntryMarkdown
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
