import { config } from '../config.js';
import { appendTasksForDate, readTasksForDate } from './googleDriveState.js';
import { createStructuredOutput } from './openaiClient.js';

const ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'reason'],
  properties: {
    action: {
      type: 'string',
      enum: ['save_tasks', 'list_tasks', 'others']
    },
    reason: { type: 'string' }
  }
};

const TASK_SPLIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'status'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          status: {
            type: 'string',
            enum: ['todo']
          }
        }
      }
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

function normalizeTaskDraft(task) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return null;

  const title = String(task.title || '').trim().replace(/\s+/g, ' ');
  if (!title) return null;

  const detail = String(task.detail || '').trim().replace(/\s+/g, ' ');

  return {
    title: title.slice(0, 120),
    detail: detail.slice(0, 280),
    status: 'todo'
  };
}

function buildActionPrompt({ text, dateKey, localTime, timeZone }) {
  return [
    'あなたは個人向けLINE秘書のアクション分類器です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    '次の3つから必ず1つだけ選んでください。',
    '- save_tasks: ユーザーが今日のタスク、やること、予定を保存したい意図の発話。',
    '- list_tasks: ユーザーが今日のタスク一覧を知りたい、確認したい意図の発話。',
    '- others: それ以外。雑談、あいさつ、曖昧な発話、副作用を起こすべきでない発話を含む。',
    '',
    '自然な日本語として広く解釈してください。',
    'この段階ではタスク分割はしません。',
    'JSONオブジェクトのみを返してください。',
    '',
    'ユーザーメッセージ:',
    text
  ].join('\n');
}

function buildTaskSplitPrompt({ text, dateKey, localTime, timeZone }) {
  return [
    'あなたはユーザーメッセージから、今日保存すべきタスクを抽出する役割です。',
    `現在のローカル日付: ${dateKey}`,
    `現在のローカル時刻: ${localTime}`,
    `タイムゾーン: ${timeZone}`,
    '',
    'ルール:',
    '- 複数のタスクが含まれていれば、保存単位ごとに分割してください。',
    '- title は短く、行動が分かる表現にしてください。',
    '- 時間、条件、補足、制約は detail に入れてください。',
    '- あいさつや雑談の部分は無視してください。',
    '- 今日のtodoとして保存できる内容だけを抽出してください。',
    '- 保存対象が実質ない場合は空配列を返してください。',
    '- status は必ず "todo" にしてください。',
    '',
    'JSONオブジェクトのみを返してください。',
    '',
    'ユーザーメッセージ:',
    text
  ].join('\n');
}

async function classifyAction({ text, dateContext }) {
  return createStructuredOutput({
    model: config.openai.actionModel,
    schemaName: 'action_plan',
    schema: ACTION_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildActionPrompt({ text, ...dateContext })
  });
}

async function extractTasks({ text, dateContext }) {
  return createStructuredOutput({
    model: config.openai.taskModel,
    schemaName: 'save_tasks_payload',
    schema: TASK_SPLIT_SCHEMA,
    systemPrompt: '必ずスキーマに一致する正しいJSONオブジェクトだけを返してください。',
    userPrompt: buildTaskSplitPrompt({ text, ...dateContext })
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
  const actionPlan = await classifyAction({ text: rawText, dateContext });

  if (actionPlan.action === 'save_tasks') {
    const extracted = await extractTasks({ text: rawText, dateContext });
    const tasks = (Array.isArray(extracted.tasks) ? extracted.tasks : [])
      .map((task) => normalizeTaskDraft(task))
      .filter(Boolean);

    if (tasks.length === 0) {
      throw new Error('タスクを解釈できませんでした。もう一度具体的に送ってください。');
    }

    const savedTasks = await appendTasksForDate({
      dateKey: dateContext.dateKey,
      userId,
      tasks
    });

    return `タスクを保存しました（${savedTasks.length}件）`;
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
