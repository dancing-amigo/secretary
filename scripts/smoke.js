import fs from 'fs';
import path from 'path';
import { processUserMessage } from '../src/services/assistantEngine.js';
import { store } from '../src/services/store.js';

const statePath = path.join(process.cwd(), 'data', 'state.json');
fs.writeFileSync(
  statePath,
  JSON.stringify(
    {
      users: {},
      tasks: [],
      scheduleBlocks: [],
      reminderJobs: [],
      dailyPlans: {},
      changeRequests: [],
      memoryRevisions: [],
      runtimePrefs: {},
      meta: { lastRevision: 0 }
    },
    null,
    2
  )
);

const msgs = [
  'タスク追加: 企画書作成',
  '今日の計画',
  '確定',
  '覚えて: 午後は会議後30分バッファ',
  '前の変更を取り消して',
  '忘れて:',
  'タスク一覧'
];

for (const text of msgs) {
  const reply = await processUserMessage({ userId: 'U_demo', text });
  console.log(`> ${text}`);
  console.log(reply.split('\n').slice(0, 5).join('\n'));
  console.log('---');
}

const pending = store.getState().changeRequests.find((x) => x.status === 'needs_confirmation');
if (pending) {
  const reply = await processUserMessage({ userId: 'U_demo', text: `承認 ${pending.id}` });
  console.log(`> 承認 ${pending.id}`);
  console.log(reply);
}
