import fs from 'fs';
import path from 'path';
import { appendMemoryFact, forgetMemoryFact, rollbackLastRevision, tuneRule } from './memory.js';
import { store } from './store.js';

const pendingDir = path.join(process.cwd(), 'memory', '60_adaptation', 'pending');

function riskLevel(intent, payload) {
  if (intent === 'forget' && payload.keyword && payload.keyword.length <= 1) return 'high';
  if (intent === 'forget' && !payload.keyword) return 'high';
  if (intent === 'tune' && payload.memoryText && payload.memoryText.includes('全部')) return 'high';
  return 'low';
}

function executeMutation(userId, intentObj) {
  const { type } = intentObj;

  if (type === 'remember') {
    const text = intentObj.memoryText || '';
    const rev = appendMemoryFact(text, 'remember', userId);
    return { applied: true, message: `記憶を追加しました（${rev.id}）。` };
  }

  if (type === 'forget') {
    const keyword = intentObj.keyword || '';
    if (!keyword.trim()) {
      return { applied: false, message: '忘却対象のキーワードが空です。例: 忘れて: 夜の重作業ルール' };
    }
    const rev = forgetMemoryFact(keyword, userId);
    return { applied: true, message: `「${keyword}」に関する記憶を整理しました（${rev.id}）。` };
  }

  if (type === 'tune') {
    const rule = intentObj.memoryText || '調整';
    const rev = tuneRule(rule, userId);
    const patch = {};
    if (rule.includes('強め')) patch.notificationTone = 'strong';
    if (rule.includes('弱め')) patch.notificationTone = 'soft';
    if (Object.keys(patch).length > 0) store.updateRuntimePrefs(userId, patch);
    return { applied: true, message: `運用ルールを更新しました（${rev.id}）。` };
  }

  if (type === 'rollback') {
    const out = rollbackLastRevision(userId);
    if (!out) return { applied: false, message: '戻せる変更履歴がありません。' };
    return { applied: true, message: `変更 ${out.rollbackOf} を取り消しました（${out.revision.id}）。` };
  }

  return { applied: false, message: '変更対象が見つかりませんでした。' };
}

export function applyMemoryMutation(userId, intentObj) {
  const { type } = intentObj;
  const risk = riskLevel(type, intentObj);

  if (risk === 'high') {
    const req = store.appendChangeRequest({
      userId,
      intent: type,
      riskLevel: risk,
      status: 'needs_confirmation',
      payload: intentObj
    });
    fs.writeFileSync(path.join(pendingDir, `${req.id}.md`), `# Pending Change\n\n- id: ${req.id}\n- intent: ${type}\n- payload: ${JSON.stringify(intentObj)}\n`);
    return {
      applied: false,
      needsConfirmation: true,
      message: `この変更は影響が大きい可能性があります。承認する場合は「承認 ${req.id}」と返信してください。`
    };
  }

  const out = executeMutation(userId, intentObj);
  store.appendChangeRequest({ userId, intent: type, riskLevel: risk, payload: intentObj, status: out.applied ? 'applied' : 'rejected', appliedAt: new Date().toISOString() });
  return out;
}

export function approveChangeRequest(userId, requestId) {
  const req = store.findChangeRequest(requestId);
  if (!req) return { ok: false, message: `該当リクエストがありません: ${requestId}` };
  if (req.status !== 'needs_confirmation') return { ok: false, message: `このリクエストは承認不要です: ${requestId}` };

  const out = executeMutation(userId, req.payload || {});
  store.updateChangeRequest(requestId, {
    status: out.applied ? 'applied' : 'rejected',
    approvedBy: userId,
    approvedAt: new Date().toISOString(),
    resultMessage: out.message
  });

  const pendingPath = path.join(pendingDir, `${requestId}.md`);
  if (fs.existsSync(pendingPath)) fs.unlinkSync(pendingPath);

  return { ok: out.applied, message: out.message };
}
