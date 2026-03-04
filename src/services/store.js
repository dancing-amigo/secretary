import fs from 'fs';
import path from 'path';
import { makeId } from '../utils/id.js';
import { nowIso } from '../utils/time.js';

const root = process.cwd();
const statePath = path.join(root, 'data', 'state.json');

function load() {
  const raw = fs.readFileSync(statePath, 'utf8');
  return JSON.parse(raw);
}

function save(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function withState(fn) {
  const state = load();
  const out = fn(state);
  save(state);
  return out;
}

export const store = {
  getState: load,

  upsertUser(userId) {
    return withState((s) => {
      if (!s.users[userId]) {
        s.users[userId] = { id: userId, createdAt: nowIso() };
      }
      s.users[userId].lastSeenAt = nowIso();
      return s.users[userId];
    });
  },

  listUserIds() {
    return Object.keys(load().users);
  },

  listOpenTasks() {
    return load().tasks.filter((t) => t.status !== 'done' && t.status !== 'canceled');
  },

  getTask(taskId) {
    return load().tasks.find((t) => t.id === taskId) || null;
  },

  createTask(input) {
    return withState((s) => {
      const task = {
        id: makeId('task'),
        title: input.title,
        status: input.status || 'todo',
        priority: input.priority ?? 3,
        estimateMin: input.estimateMin ?? 45,
        scheduledStart: input.scheduledStart || null,
        scheduledEnd: input.scheduledEnd || null,
        dueAt: input.dueAt || null,
        project: input.project || null,
        source: input.source || 'line',
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      s.tasks.push(task);
      return task;
    });
  },

  updateTask(taskId, patch) {
    return withState((s) => {
      const task = s.tasks.find((t) => t.id === taskId);
      if (!task) return null;
      Object.assign(task, patch, { updatedAt: nowIso() });
      return task;
    });
  },

  removeTask(taskId) {
    return withState((s) => {
      const before = s.tasks.length;
      s.tasks = s.tasks.filter((t) => t.id !== taskId);
      s.reminderJobs = s.reminderJobs.filter((j) => j.taskId !== taskId);
      return s.tasks.length !== before;
    });
  },

  replacePlan(date, blocks, confirmed = false) {
    return withState((s) => {
      s.dailyPlans[date] = {
        date,
        blocks,
        confirmed,
        updatedAt: nowIso()
      };
      return s.dailyPlans[date];
    });
  },

  getPlan(date) {
    return load().dailyPlans[date] || null;
  },

  confirmPlan(date) {
    return withState((s) => {
      const plan = s.dailyPlans[date];
      if (!plan) return null;
      plan.confirmed = true;
      plan.confirmedAt = nowIso();
      return plan;
    });
  },

  resetReminderJobsForDate(datePrefix) {
    return withState((s) => {
      s.reminderJobs = s.reminderJobs.filter((j) => !j.scheduledAt.startsWith(datePrefix));
      return s.reminderJobs.length;
    });
  },

  addReminderJob(job) {
    return withState((s) => {
      const entity = {
        id: makeId('job'),
        status: 'pending',
        createdAt: nowIso(),
        attempts: 0,
        ...job
      };
      s.reminderJobs.push(entity);
      return entity;
    });
  },

  dueReminderJobs(now = Date.now()) {
    return load().reminderJobs.filter((j) => j.status === 'pending' && new Date(j.scheduledAt).getTime() <= now);
  },

  markReminderJob(jobId, patch) {
    return withState((s) => {
      const job = s.reminderJobs.find((j) => j.id === jobId);
      if (!job) return null;
      Object.assign(job, patch);
      return job;
    });
  },

  appendChangeRequest(req) {
    return withState((s) => {
      const row = { id: makeId('cr'), requestedAt: nowIso(), status: 'applied', ...req };
      s.changeRequests.push(row);
      return row;
    });
  },

  findChangeRequest(id) {
    return load().changeRequests.find((r) => r.id === id) || null;
  },

  updateChangeRequest(id, patch) {
    return withState((s) => {
      const row = s.changeRequests.find((r) => r.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    });
  },

  addMemoryRevision(revision) {
    return withState((s) => {
      s.meta.lastRevision += 1;
      const row = { id: `rev_${String(s.meta.lastRevision).padStart(6, '0')}`, createdAt: nowIso(), ...revision };
      s.memoryRevisions.push(row);
      return row;
    });
  },

  listMemoryRevisions(limit = 20) {
    return load().memoryRevisions.slice(-limit).reverse();
  },

  updateRuntimePrefs(userId, patch) {
    return withState((s) => {
      if (!s.runtimePrefs[userId]) {
        s.runtimePrefs[userId] = {
          notificationTone: 'normal',
          nudgePolicy: 'standard',
          planningDepth: 'normal'
        };
      }
      Object.assign(s.runtimePrefs[userId], patch);
      return s.runtimePrefs[userId];
    });
  },

  getRuntimePrefs(userId) {
    const s = load();
    return s.runtimePrefs[userId] || {
      notificationTone: 'normal',
      nudgePolicy: 'standard',
      planningDepth: 'normal'
    };
  }
};
