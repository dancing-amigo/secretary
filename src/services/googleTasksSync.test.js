import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoogleTaskSyncPlan } from './googleTasksSync.js';

test('buildGoogleTaskSyncPlan creates upserts for local tasks and deletes stale mappings', () => {
  const plan = buildGoogleTaskSyncPlan({
    dateKey: '2026-03-07',
    localTasks: [
      { id: 'task-a', title: 'A', detail: '', status: 'todo' },
      { id: 'task-b', title: 'B', detail: 'note', status: 'done' }
    ],
    mappings: [
      {
        localTaskId: 'task-b',
        googleTaskId: 'google-b',
        taskListId: '@default',
        dateKey: '2026-03-07'
      },
      {
        localTaskId: 'task-c',
        googleTaskId: 'google-c',
        taskListId: '@default',
        dateKey: '2026-03-07'
      },
      {
        localTaskId: 'task-old-date',
        googleTaskId: 'google-old',
        taskListId: '@default',
        dateKey: '2026-03-06'
      }
    ]
  });

  assert.deepEqual(
    plan.map((item) => ({ type: item.type, localTaskId: item.localTaskId })),
    [
      { type: 'create', localTaskId: 'task-a' },
      { type: 'upsert', localTaskId: 'task-b' },
      { type: 'delete', localTaskId: 'task-c' }
    ]
  );
});
