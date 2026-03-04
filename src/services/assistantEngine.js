import { detectIntent } from './intent.js';
import { store } from './store.js';
import { applyMemoryMutation, approveChangeRequest } from './adaptation.js';
import { buildDailyPlan, renderPlanTable } from './planner.js';
import { scheduleJobsFromPlan } from './reminders.js';
import { logConversationLine, logDailyLine } from './memory.js';
import { formatYmd, addMinutes, toJpTime } from '../utils/time.js';
import { upsertTaskEvent } from './calendarClient.js';
import { textResponse } from './openaiClient.js';

function renderTasks(tasks) {
  if (!tasks.length) return '未完了タスクはありません。';
  const lines = ['未完了タスク一覧:'];
  tasks.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title} / 優先度${t.priority} / 見積${t.estimateMin}分 / 状態${t.status}`);
  });
  return lines.join('\n');
}

function normalizeTaskTitle(raw) {
  let t = String(raw || '').trim();
  if (!t) return '未命名タスク';

  // Drop temporal/context prefixes so task memory stores the core work item.
  const prefixPatterns = [
    /^(今日は?|今日|今夜|明日|あと|これから)\s*/u,
    /^(寝る前に|朝に|午後に|午前に|夜に)\s*/u
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of prefixPatterns) {
      if (re.test(t)) {
        t = t.replace(re, '').trim();
        changed = true;
      }
    }
  }

  t = t
    .replace(/(を)?(する|やる)(だけ)?(です|ます)?$/u, '')
    .replace(/だけです$/u, '')
    .replace(/[。！!]+$/u, '')
    .trim();

  return t || String(raw).trim() || '未命名タスク';
}

function composeAckReply(userId) {
  const open = store.listOpenTasks(userId);
  if (open.length === 0) {
    return 'いいですね。今は未完了タスクなしです。この流れでいきましょう。';
  }
  if (open.length === 1) {
    return `ありがとうございます。残りは「${open[0].title}」だけです。必要なら次の着手タイミングも決めます。`;
  }
  return `ありがとうございます。残タスクは${open.length}件あります。優先順を一緒に整えますか？`;
}

function latestActiveTask(userId) {
  const tasks = store.listOpenTasks(userId);
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

async function humanizeReply({ userId, userText, intentType, deterministicText }) {
  const recent = store.getRecentConversation(userId, 10);
  const openTasks = store.listOpenTasks(userId).slice(0, 5).map((t) => ({ title: t.title, estimateMin: t.estimateMin, status: t.status }));

  try {
    const rewritten = await textResponse({
      system: [
        'You are a Japanese LINE secretary assistant.',
        'Rewrite the deterministic reply into natural, human conversational Japanese.',
        'Keep all factual content unchanged. Do not invent tasks, times, or statuses.',
        'Length: 1-3 short lines.',
        'Tone: warm, practical, not robotic.'
      ].join(' '),
      user: JSON.stringify(
        {
          userText,
          intentType,
          deterministicReply: deterministicText,
          openTasks,
          recentConversation: recent
        },
        null,
        2
      ),
      temperature: 0.85
    });

    const out = (rewritten || '').trim();
    if (!out) return deterministicText;
    return out;
  } catch {
    return deterministicText;
  }
}

export async function processUserMessage({ userId, text }) {
  store.upsertUser(userId);
  const date = ymdNow();
  logConversationLine(date, `- user: ${text}`);
  store.appendConversation(userId, 'user', text);

  const intent = await detectIntent(text, {
    openTasks: store.listOpenTasks(userId).map((t) => ({
      id: t.id,
      title: t.title,
      estimateMin: t.estimateMin,
      status: t.status
    }))
  });

  const respond = async (deterministicText) => {
    const reply = await humanizeReply({
      userId,
      userText: text,
      intentType: intent.type,
      deterministicText
    });
    store.appendConversation(userId, 'assistant', reply);
    return reply;
  };

  if (text.startsWith('承認 ')) {
    const requestId = text.replace('承認', '').trim();
    const out = approveChangeRequest(userId, requestId);
    return respond(out.message);
  }

  if (['remember', 'forget', 'tune', 'rollback'].includes(intent.type)) {
    const out = applyMemoryMutation(userId, intent);
    logDailyLine(date, `- memory_change: ${intent.type} ${JSON.stringify(intent)}`);
    return respond(out.message);
  }

  if (intent.type === 'add_task') {
    const canonicalTitle = normalizeTaskTitle(intent.taskTitle || '未命名タスク');
    const task = store.createTask({
      userId,
      title: canonicalTitle,
      priority: intent.priority ?? 3,
      estimateMin: intent.minutes ?? 45,
      source: 'line'
    });
    logDailyLine(date, `- task_add: ${task.id} ${task.title}`);
    return respond(`タスクを追加しました: ${task.title}（${task.id}）`);
  }

  if (intent.type === 'delete_task') {
    const keyword = intent.taskTitle || '';
    const target = store.listOpenTasks(userId).find((t) => t.title.includes(keyword));
    if (!target) return respond(`削除対象が見つかりませんでした: ${keyword}`);
    store.removeTask(target.id);
    logDailyLine(date, `- task_delete: ${target.id} ${target.title}`);
    return respond(`削除しました: ${target.title}`);
  }

  if (intent.type === 'show_tasks') {
    return respond(renderTasks(store.listOpenTasks(userId)));
  }

  if (intent.type === 'ack') {
    return respond(composeAckReply(userId));
  }

  if (intent.type === 'show_plan') {
    let plan = store.getPlan(userId, date);
    if (!plan || !plan.blocks || plan.blocks.length === 0) {
      plan = await buildDailyPlan({ userId });
    }
    return respond(renderPlanTable(plan));
  }

  if (intent.type === 'confirm_plan') {
    const plan = store.confirmPlan(userId, date);
    if (!plan) return respond('確定するプランがありません。先に「今日の計画」を作成します。');

    const jobs = scheduleJobsFromPlan(userId, plan);
    for (const b of plan.blocks) {
      const task = store.updateTask(b.taskId, { status: 'todo', scheduledStart: b.startAt, scheduledEnd: b.endAt });
      if (task) await upsertTaskEvent(task).catch(() => null);
    }

    const summary = ['プランを確定しました。', `通知ジョブ: ${jobs}件を登録。`, '', '確定プラン:'];
    for (const b of plan.blocks) {
      summary.push(`- ${toJpTime(b.startAt)}-${toJpTime(b.endAt)} ${b.title}`);
    }
    return respond(summary.join('\n'));
  }

  if (intent.type === 'complete_task') {
    const task = latestActiveTask(userId);
    if (!task) return respond('完了対象のタスクが見つかりません。');
    store.updateTask(task.id, { status: 'done' });
    logDailyLine(date, `- task_done: ${task.id}`);
    return respond(`完了にしました: ${task.title}`);
  }

  if (intent.type === 'not_done') {
    const task = latestActiveTask(userId);
    if (!task) return respond('対象タスクが見つかりません。');
    store.updateTask(task.id, { status: 'todo' });
    return respond(`未完了として保持しました: ${task.title}`);
  }

  if (intent.type === 'extend_task') {
    const task = latestActiveTask(userId);
    if (!task) return respond('延長対象が見つかりません。');
    const m = intent.minutes || 15;
    const end = task.scheduledEnd || new Date().toISOString();
    const newEnd = addMinutes(end, m);
    store.updateTask(task.id, { status: 'doing', scheduledEnd: newEnd, estimateMin: Number(task.estimateMin || 45) + m });
    return respond(`延長しました: ${task.title} を ${m}分（終了見込み ${toJpTime(newEnd)}）`);
  }

  if (intent.type === 'update_task') {
    const mins = Number(intent.minutes || 0);
    if (!mins || mins < 5) return respond('見積もり時間は5分以上で指定してください。');

    const keyword = (intent.taskTitle || '').trim();
    let target = null;
    if (keyword) {
      target = store.listOpenTasks(userId).find((t) => t.title.includes(keyword));
    }
    if (!target) target = latestActiveTask(userId);
    if (!target) return respond('更新対象タスクが見つかりません。');

    const patch = { estimateMin: mins };
    if (target.scheduledStart) {
      patch.scheduledEnd = addMinutes(target.scheduledStart, mins);
    }
    const updated = store.updateTask(target.id, patch);
    return respond(`見積もりを更新しました: ${updated.title} を ${mins}分に設定しました。`);
  }

  if (text.includes('今日') && text.includes('やる')) {
    const plan = await buildDailyPlan({ userId });
    return respond(renderPlanTable(plan));
  }

  if (intent.type === 'unknown') {
    return respond('話しかけてくれてありがとう。次の行動や変更したいことを自然文でそのまま言ってください。');
  }

  return respond('処理しました。');
}

export async function runMorningPlan(userId) {
  const plan = await buildDailyPlan({ userId });
  return renderPlanTable(plan);
}

export function runNightReview(userId) {
  const tasks = store.listOpenTasks(userId);
  const done = store.getState().tasks.filter((t) => t.userId === userId && t.status === 'done').length;
  const open = tasks.length;
  return [`今日のレビューです。`, `完了: ${done}件`, `未完了: ${open}件`, '明日の朝に再計画を送ります。'].join('\n');
}
