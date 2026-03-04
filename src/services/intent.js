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
        'ack',
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
  const lower = t.toLowerCase();

  const pick = (patterns) => patterns.find((p) => p.test(t));
  const extractMinutes = () => {
    const m = t.match(/(\d+)\s*分/);
    return m ? Number(m[1]) : 15;
  };
  const cleanTitle = (s) =>
    s
      .replace(/^(タスク|TODO|todo|課題|案件)\s*/i, '')
      .replace(/^(を|は|が|の)\s*/u, '')
      .replace(/(して|する|したい|したほうがいい|お願いします|おねがいします|追加|登録|削除|消して|やめて)$/u, '')
      .replace(/[:：]/g, '')
      .trim();
  const after = (re) => {
    const m = t.match(re);
    return m?.[1] ? cleanTitle(m[1]) : '';
  };

  if (pick([/^確定$/, /この.*(プラン|予定).*(で|に).*(確定|決定|ok|OK)/, /(これで|このまま).*(いこう|進めて)/])) {
    return { type: 'confirm_plan' };
  }
  if (pick([/終わった/, /完了(した)?/, /できた/, /済んだ/, /終わりました/])) return { type: 'complete_task' };
  if (pick([/未完/, /終わってない/, /まだ(です|だ)?$/, /できてない/, /終わらなかった/])) return { type: 'not_done' };
  if (pick([/延長/, /あと\s*\d+\s*分/, /もう少し/])) return { type: 'extend_task', minutes: extractMinutes() };

  if (pick([/前の変更.*(戻して|取り消して)/, /元に戻して/, /ロールバック/])) return { type: 'rollback' };

  if (pick([/覚えて/, /覚えといて/, /記憶して/, /今後は/, /これからは/])) {
    const mem =
      after(/(?:覚えて|覚えといて|記憶して)\s*[:：]?\s*(.+)$/u) ||
      after(/(?:今後は|これからは)\s*(.+)$/u) ||
      t;
    return { type: 'remember', memoryText: mem };
  }
  if (pick([/忘れて/, /消して/, /無効にして/, /間違ってるから消して/])) {
    const keyword =
      after(/(?:忘れて|消して|無効にして|取り消して)\s*[:：]?\s*(.+)$/u) ||
      after(/(.+)は間違ってる/u);
    return { type: 'forget', keyword };
  }
  if (pick([/通知/, /口調/, /厳しめ/, /優しめ/, /強め/, /弱め/])) return { type: 'tune', memoryText: t };

  if (
    pick([
      /^タスク追加\s*[:：]/,
      /^追加\s*[:：]/,
      /(.+)(を|の)?(タスク|todo|TODO|課題)に(追加|登録)/,
      /(追加|登録).*(タスク|todo|TODO|課題)/,
      /(.+)(を)?(やる|する)必要(がある)?/,
      /今日は(.+)を(やる|する)/
    ])
  ) {
    const taskTitle =
      after(/^(?:タスク追加|追加)\s*[:：]\s*(.+)$/u) ||
      after(/(.+?)(?:を|の)?(?:タスク|todo|TODO|課題)に(?:追加|登録)/u) ||
      after(/(?:追加|登録)\s*[:：]?\s*(.+)$/u) ||
      after(/(?:今日は)?\s*(.+?)\s*を(?:やる|する)/u);
    return { type: 'add_task', taskTitle: taskTitle || '未命名タスク' };
  }

  if (
    pick([
      /(見積|見積もり|所要時間).*(\d+)\s*分/,
      /(\d+)\s*分.*(にして|に変更|くらい|かかる)/,
      /(.+?)は(\d+)\s*分/,
      /(編集|修正).*(\d+)\s*分/
    ])
  ) {
    const m1 = t.match(/(?:見積|見積もり|所要時間)[^0-9]*(\d+)\s*分/u);
    const m2 = t.match(/(\d+)\s*分/u);
    const minutes = Number(m1?.[1] || m2?.[1] || 0) || 0;
    const title =
      after(/^(.+?)\s*(?:の)?(?:見積|見積もり|所要時間)/u) ||
      after(/^(.+?)は\d+\s*分/u) ||
      after(/^(.+?)\s*(?:を)?(?:編集|修正)/u);
    if (minutes > 0) return { type: 'update_task', taskTitle: title, minutes };
  }

  if (pick([/(.+)を(削除|消して|やめて|不要)/, /(削除|消して|やめて|不要).*(タスク|課題)/])) {
    const taskTitle = after(/(.+?)を(?:削除|消して|やめて|不要)/u) || after(/(?:削除|消して)\s*[:：]?\s*(.+)$/u);
    return { type: 'delete_task', taskTitle };
  }

  if (
    pick([
      /今日.*(何|なに).*(やる|すべき|したら)/,
      /今日の(計画|予定|プラン)/,
      /(予定|プラン|スケジュール).*(立てて|組んで)/,
      /what should i do today/i
    ])
  ) {
    return { type: 'show_plan' };
  }

  if (
    pick([
      /タスク一覧/,
      /今ある.*タスク/,
      /いまある.*タスク/,
      /現在.*タスク/,
      /何が残ってる/,
      /残タスク/,
      /抱えてるタスク/,
      /todo一覧/i,
      /open tasks/i
    ])
  ) {
    return { type: 'show_tasks' };
  }

  if (
    pick([
      /^(いいね|了解|ok|OK|ありがとう|助かる|ナイス|いい感じ)$/i,
      /(素晴らしい|すばらしい|最高|完璧|いい感じ|いい流れ)/,
      /(助かる|ありがたい|great|awesome|nice)/i
    ])
  ) {
    return { type: 'ack' };
  }

  if (lower === 'ping') return { type: 'show_plan' };
  return { type: 'unknown' };
}

export async function detectIntent(text, context = {}) {
  const fb = fallback(text);
  try {
    const openTasks = Array.isArray(context.openTasks) ? context.openTasks : [];
    const contextText = JSON.stringify({ openTasks }, null, 2);
    const json = await jsonResponse({
      system:
        [
          'You are an intent classifier for a Japanese LINE secretary app.',
          'Users speak natural Japanese, not commands.',
          'Classify intent and extract fields.',
          'For add_task, set taskTitle to canonical core work item by dropping temporal wrappers like: 今日は, あと, 寝る前に, 今夜.',
          'For update_task, extract minutes and pick the most likely taskTitle from openTasks if user does not repeat the title.',
          'For short positive acknowledgements (e.g. いいね, 了解, ありがとう), return type=ack.',
          'Return JSON only.'
        ].join(' '),
      user: `message:\n${text}\n\ncontext:\n${contextText}`,
      schemaHint: schema
    });
    if (json && json.type) {
      if (json.type === 'unknown' && fb.type !== 'unknown') return fb;
      return json;
    }
  } catch {
    // fallthrough
  }
  return fb;
}
