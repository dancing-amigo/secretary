import { detectIntent } from './intent.js';
import { store } from './store.js';
import { applyMemoryMutation, approveChangeRequest } from './adaptation.js';
import { buildDailyPlan, renderPlanTable } from './planner.js';
import { scheduleJobsFromPlan } from './reminders.js';
import { logConversationLine, logDailyLine } from './memory.js';
import { formatYmd, addMinutes, toJpTime } from '../utils/time.js';
import { upsertTaskEvent } from './calendarClient.js';

function renderTasks(tasks) {
  if (!tasks.length) return '未完了タスクはありません。';
  const lines = ['未完了タスク一覧:'];
  tasks.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title} / 優先度${t.priority} / 見積${t.estimateMin}分 / 状態${t.status}`);
  });
  return lines.join('\n');
}

function latestActiveTask() {
  const tasks = store.listOpenTasks();
  const ongoing = tasks.find((t) => t.status === 'doing');
  if (ongoing) return ongoing;

  const now = Date.now();
  const withSchedule = tasks
    .filter((t) => t.scheduledStart && t.scheduledEnd)
    .sort((a, b) => Math.abs(new Date(a.scheduledStart).getTime() - now) - Math.abs(new Date(b.scheduledStart).getTime() - now));

  return withSchedule[0] || tasks[0] || null;
}

function ymdNow() {
  return formatYmd(new Date());
}

export async function processUserMessage({ userId, text }) {
  store.upsertUser(userId);
  const date = ymdNow();
  logConversationLine(date, `- user: ${text}`);

  const intent = await detectIntent(text);

  if (text.startsWith('承認 ')) {
    const requestId = text.replace('承認', '').trim();
    const out = approveChangeRequest(userId, requestId);
    return out.message;
  }

  if (['remember', 'forget', 'tune', 'rollback'].includes(intent.type)) {
    const out = applyMemoryMutation(userId, intent);
    logDailyLine(date, `- memory_change: ${intent.type} ${JSON.stringify(intent)}`);
    return out.message;
  }

  if (intent.type === 'add_task') {
    const task = store.createTask({
      title: intent.taskTitle || '未命名タスク',
      priority: intent.priority ?? 3,
      estimateMin: intent.minutes ?? 45,
      source: 'line'
    });
    logDailyLine(date, `- task_add: ${task.id} ${task.title}`);
    return `タスクを追加しました: ${task.title}（${task.id}）`;
  }

  if (intent.type === 'delete_task') {
    const keyword = intent.taskTitle || '';
    const target = store.listOpenTasks().find((t) => t.title.includes(keyword));
    if (!target) return `削除対象が見つかりませんでした: ${keyword}`;
    store.removeTask(target.id);
    logDailyLine(date, `- task_delete: ${target.id} ${target.title}`);
    return `削除しました: ${target.title}`;
  }

  if (intent.type === 'show_tasks') {
    return renderTasks(store.listOpenTasks());
  }

  if (intent.type === 'show_plan') {
    let plan = store.getPlan(date);
    if (!plan || !plan.blocks || plan.blocks.length === 0) {
      plan = await buildDailyPlan();
    }
    return renderPlanTable(plan);
  }

  if (intent.type === 'confirm_plan') {
    const plan = store.confirmPlan(date);
    if (!plan) return '確定するプランがありません。先に「今日の計画」を作成します。';

    const jobs = scheduleJobsFromPlan(plan);
    for (const b of plan.blocks) {
      const task = store.updateTask(b.taskId, { status: 'todo', scheduledStart: b.startAt, scheduledEnd: b.endAt });
      if (task) await upsertTaskEvent(task).catch(() => null);
    }

    const summary = ['プランを確定しました。', `通知ジョブ: ${jobs}件を登録。`, '', '確定プラン:'];
    for (const b of plan.blocks) {
      summary.push(`- ${toJpTime(b.startAt)}-${toJpTime(b.endAt)} ${b.title}`);
    }
    return summary.join('\n');
  }

  if (intent.type === 'complete_task') {
    const task = latestActiveTask();
    if (!task) return '完了対象のタスクが見つかりません。';
    store.updateTask(task.id, { status: 'done' });
    logDailyLine(date, `- task_done: ${task.id}`);
    return `完了にしました: ${task.title}`;
  }

  if (intent.type === 'not_done') {
    const task = latestActiveTask();
    if (!task) return '対象タスクが見つかりません。';
    store.updateTask(task.id, { status: 'todo' });
    return `未完了として保持しました: ${task.title}`;
  }

  if (intent.type === 'extend_task') {
    const task = latestActiveTask();
    if (!task) return '延長対象が見つかりません。';
    const m = intent.minutes || 15;
    const end = task.scheduledEnd || new Date().toISOString();
    const newEnd = addMinutes(end, m);
    store.updateTask(task.id, { status: 'doing', scheduledEnd: newEnd, estimateMin: Number(task.estimateMin || 45) + m });
    return `延長しました: ${task.title} を ${m}分（終了見込み ${toJpTime(newEnd)}）`;
  }

  if (text.includes('今日') && text.includes('やる')) {
    const plan = await buildDailyPlan();
    return renderPlanTable(plan);
  }

  if (intent.type === 'unknown') {
    return '了解です。必要なら「タスク追加: ○○」「覚えて: ○○」「忘れて: ○○」「今日の計画」「確定」で指示してください。';
  }

  return '処理しました。';
}

export async function runMorningPlan() {
  const plan = await buildDailyPlan();
  return renderPlanTable(plan);
}

export function runNightReview() {
  const tasks = store.getState().tasks;
  const done = tasks.filter((t) => t.status === 'done').length;
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled').length;
  return [`今日のレビューです。`, `完了: ${done}件`, `未完了: ${open}件`, '明日の朝に再計画を送ります。'].join('\n');
}
