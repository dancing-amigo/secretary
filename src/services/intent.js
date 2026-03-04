import { jsonResponse } from './openaiClient.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: {
      type: 'string',
      enum: [
        'confirm_plan',
        'complete_task',
        'not_done',
        'extend_task',
        'add_task',
        'delete_task',
        'update_task',
        'remember',
        'forget',
        'tune',
        'rollback',
        'show_plan',
        'show_tasks',
        'unknown'
      ]
    },
    taskTitle: { type: 'string' },
    memoryText: { type: 'string' },
    keyword: { type: 'string' },
    minutes: { type: 'number' },
    priority: { type: 'number' }
  },
  required: ['type']
};

function fallback(text) {
  const t = text.trim();
  if (/^確定$/.test(t) || t.includes('確定')) return { type: 'confirm_plan' };
  if (t.includes('完了')) return { type: 'complete_task' };
  if (t.includes('未完') || t.includes('終わってない')) return { type: 'not_done' };
  if (t.includes('延長')) {
    const m = t.match(/(\d+)\s*分/);
    return { type: 'extend_task', minutes: m ? Number(m[1]) : 15 };
  }
  if (t.includes('覚えて')) {
    return { type: 'remember', memoryText: t.replace('覚えて', '').replace(':', '').trim() };
  }
  if (t.includes('忘れて')) {
    return { type: 'forget', keyword: t.replace('忘れて', '').replace(':', '').trim() };
  }
  if (t.includes('戻して') || t.includes('取り消')) return { type: 'rollback' };
  if (t.includes('通知') || t.includes('口調') || t.includes('これからは')) {
    return { type: 'tune', memoryText: t };
  }
  if (t.startsWith('追加') || t.includes('タスク追加') || t.includes('やること')) {
    const title = t.replace('追加', '').replace('タスク', '').replace(':', '').trim();
    return { type: 'add_task', taskTitle: title || '未命名タスク' };
  }
  if (t.includes('削除')) {
    const title = t.replace('削除', '').replace('タスク', '').replace(':', '').trim();
    return { type: 'delete_task', taskTitle: title };
  }
  if (t.includes('今日の計画') || t.includes('プラン')) return { type: 'show_plan' };
  if (t.includes('タスク一覧')) return { type: 'show_tasks' };
  return { type: 'unknown' };
}

export async function detectIntent(text) {
  try {
    const json = await jsonResponse({
      system: `You are an intent classifier for a Japanese LINE secretary app. Return JSON only.`,
      user: text,
      schemaHint: schema
    });
    if (json && json.type) return json;
  } catch {
    // fallthrough
  }
  return fallback(text);
}
