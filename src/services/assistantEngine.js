import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { readTaskFileForDate, readTasksForDate, replaceTaskFileForDate } from './googleDriveState.js';
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

export function runNightReview() {
  return '夜です';
}
