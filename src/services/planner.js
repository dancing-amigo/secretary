import { store } from './store.js';
import { addMinutes, formatYmd, toJpTime } from '../utils/time.js';
import { getBusySlots } from './calendarClient.js';
import { config } from '../config.js';
import { DateTime } from 'luxon';

function toRange(dateObj, minutes) {
  const safeDate = Number.isFinite(dateObj?.getTime?.()) ? dateObj : new Date();
  const start = safeDate.toISOString();
  const end = addMinutes(start, minutes) || new Date(safeDate.getTime() + minutes * 60 * 1000).toISOString();
  return { start, end };
}

function hasOverlap(candidateStart, candidateEnd, ranges) {
  const s = new Date(candidateStart).getTime();
  const e = new Date(candidateEnd).getTime();
  return ranges.some((r) => {
    const rs = new Date(r.start).getTime();
    const re = new Date(r.end).getTime();
    return s < re && rs < e;
  });
}

function nextAvailableStart(cursor, durationMin, blockedRanges) {
  let current = new Date(cursor);
  for (let i = 0; i < 240; i += 1) {
    const cand = toRange(current, durationMin);
    if (!hasOverlap(cand.start, cand.end, blockedRanges)) return cand;
    current = new Date(current.getTime() + 15 * 60 * 1000);
  }
  return toRange(current, durationMin);
}

function todayWindow() {
  const now = DateTime.now().setZone(config.tz);
  const base = now.isValid ? now : DateTime.now().setZone('America/Vancouver');
  if (!now.isValid) {
    // eslint-disable-next-line no-console
    console.error('[invalid-timezone]', config.tz);
  }
  const start = base.startOf('day').plus({ hours: 9 });
  const end = base.startOf('day').plus({ hours: 22 });
  return { start: start.toUTC().toJSDate(), end: end.toUTC().toJSDate() };
}

export async function buildDailyPlan({ userId, maxTasks = 8 } = {}) {
  if (!userId) return { date: formatYmd(new Date()), blocks: [] };
  const tasks = store
    .listOpenTasks(userId)
    .filter((t) => t.status !== 'done' && t.status !== 'canceled')
    .sort((a, b) => {
      const pr = (b.priority || 3) - (a.priority || 3);
      if (pr !== 0) return pr;
      if (a.dueAt && b.dueAt) return new Date(a.dueAt) - new Date(b.dueAt);
      return new Date(a.createdAt) - new Date(b.createdAt);
    })
    .slice(0, maxTasks);

  const { start: dayStart, end: dayEnd } = todayWindow();
  const busy = await getBusySlots(dayStart.toISOString(), dayEnd.toISOString());
  const blocked = busy.map((b) => ({ start: b.start, end: b.end }));

  const blocks = [];
  let cursor = dayStart;

  for (const task of tasks) {
    const duration = Math.max(15, Number(task.estimateMin || 45));
    const slot = nextAvailableStart(cursor, duration, blocked.concat(blocks.map((x) => ({ start: x.startAt, end: x.endAt }))));

    const block = {
      taskId: task.id,
      title: task.title,
      startAt: slot.start,
      endAt: slot.end,
      estimateMin: duration,
      status: 'planned'
    };
    blocks.push(block);
    cursor = new Date(new Date(slot.end).getTime() + 5 * 60 * 1000);

    store.updateTask(task.id, {
      scheduledStart: slot.start,
      scheduledEnd: slot.end
    });
  }

  const date = formatYmd(new Date());
  store.replacePlan(userId, date, blocks, false);
  return { userId, date, blocks };
}

export function renderPlanTable(plan) {
  if (!plan || !plan.blocks || plan.blocks.length === 0) {
    return '今日の計画候補はまだありません。タスクを追加してください。';
  }

  const lines = ['今日の提案プランです。必要なら修正して「確定」と返信してください。', '', '時刻 | タスク | 見積'];

  for (const b of plan.blocks) {
    lines.push(`${toJpTime(b.startAt)}-${toJpTime(b.endAt)} | ${b.title} | ${b.estimateMin}分`);
  }
  return lines.join('\n');
}
