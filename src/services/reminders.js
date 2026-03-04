import { store } from './store.js';
import { formatYmd, addMinutes } from '../utils/time.js';

export function scheduleJobsFromPlan(plan) {
  if (!plan || !plan.blocks) return 0;
  let count = 0;
  store.resetReminderJobsForDate(`${plan.date}`);

  for (const b of plan.blocks) {
    store.addReminderJob({
      taskId: b.taskId,
      kind: 'start',
      scheduledAt: b.startAt,
      payload: { title: b.title }
    });
    store.addReminderJob({
      taskId: b.taskId,
      kind: 'end_check',
      scheduledAt: b.endAt,
      payload: { title: b.title }
    });
    store.addReminderJob({
      taskId: b.taskId,
      kind: 'nudge1',
      scheduledAt: addMinutes(b.endAt, 10),
      payload: { title: b.title }
    });
    store.addReminderJob({
      taskId: b.taskId,
      kind: 'nudge2',
      scheduledAt: addMinutes(b.endAt, 30),
      payload: { title: b.title }
    });
    count += 4;
  }
  return count;
}

export function messageForJob(job) {
  const title = job.payload?.title || 'タスク';
  if (job.kind === 'start') return `開始時刻です: ${title}`;
  if (job.kind === 'end_check') return `終了予定です。${title} は終わりましたか？（「完了」または「未完了」で返信）`;
  if (job.kind === 'nudge1') return `進捗確認です。${title} の状況を教えてください。`;
  if (job.kind === 'nudge2') return `再通知です。${title} が未完なら、延長時間を返信してください（例: 延長15分）。`;
  return '通知です。';
}

export function shouldSkipJob(job) {
  const task = store.getTask(job.taskId);
  if (!task) return true;
  if (task.status === 'done' || task.status === 'canceled') return true;
  const today = formatYmd(new Date());
  if (!job.scheduledAt.startsWith(today)) return false;
  return false;
}
