import fs from 'fs';
import { makeId } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { ensureRuntimeSeeded, runtimePath } from './runtimeFs.js';

ensureRuntimeSeeded();

const statePath = runtimePath('data', 'state.json');

function emptyState() {
  return {
    users: {},
    tasks: [],
    scheduleBlocks: [],
    reminderJobs: [],
    dailyPlans: {},
    changeRequests: [],
    memoryRevisions: [],
    runtimePrefs: {},
    conversations: {},
    meta: { lastRevision: 0 }
  };
}

function normalizeState(raw) {
  const base = emptyState();
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    ...base,
    ...src,
    users: src.users && typeof src.users === 'object' ? src.users : {},
    tasks: Array.isArray(src.tasks) ? src.tasks : [],
    scheduleBlocks: Array.isArray(src.scheduleBlocks) ? src.scheduleBlocks : [],
    reminderJobs: Array.isArray(src.reminderJobs) ? src.reminderJobs : [],
    dailyPlans: src.dailyPlans && typeof src.dailyPlans === 'object' ? src.dailyPlans : {},
    changeRequests: Array.isArray(src.changeRequests) ? src.changeRequests : [],
    memoryRevisions: Array.isArray(src.memoryRevisions) ? src.memoryRevisions : [],
    runtimePrefs: src.runtimePrefs && typeof src.runtimePrefs === 'object' ? src.runtimePrefs : {},
    conversations: src.conversations && typeof src.conversations === 'object' ? src.conversations : {},
    meta: src.meta && typeof src.meta === 'object' ? { ...base.meta, ...src.meta } : base.meta
  };
}

function load() {
  const raw = fs.readFileSync(statePath, 'utf8');
  return normalizeState(JSON.parse(raw));
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

  listOpenTasks(userId) {
    return load().tasks.filter((t) => t.userId === userId && t.status !== 'done' && t.status !== 'canceled');
  },

  getTask(taskId) {
    return load().tasks.find((t) => t.id === taskId) || null;
  },

  createTask(input) {
    return withState((s) => {
      const task = {
        id: makeId('task'),
        userId: input.userId,
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

  replacePlan(userId, date, blocks, confirmed = false) {
    return withState((s) => {
      const key = `${userId}:${date}`;
      s.dailyPlans[key] = {
        userId,
        date,
        blocks,
        confirmed,
        updatedAt: nowIso()
      };
      return s.dailyPlans[key];
    });
  },

  getPlan(userId, date) {
    const key = `${userId}:${date}`;
    return load().dailyPlans[key] || null;
  },

  confirmPlan(userId, date) {
    return withState((s) => {
      const key = `${userId}:${date}`;
      const plan = s.dailyPlans[key];
      if (!plan) return null;
      plan.confirmed = true;
      plan.confirmedAt = nowIso();
      return plan;
    });
  },

  resetReminderJobsForDate(userId, datePrefix) {
    return withState((s) => {
      s.reminderJobs = s.reminderJobs.filter((j) => !(j.userId === userId && j.scheduledAt.startsWith(datePrefix)));
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
    return load().reminderJobs.filter((j) => j.status === 'pending' && Number.isFinite(new Date(j.scheduledAt).getTime()) && new Date(j.scheduledAt).getTime() <= now);
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
  },

  appendConversation(userId, role, text) {
    return withState((s) => {
      if (!s.conversations[userId]) s.conversations[userId] = [];
      s.conversations[userId].push({
        at: nowIso(),
        role,
        text: String(text || '')
      });
      if (s.conversations[userId].length > 80) {
        s.conversations[userId] = s.conversations[userId].slice(-80);
      }
      return true;
    });
  },

  getRecentConversation(userId, limit = 12) {
    const s = load();
    const rows = s.conversations[userId] || [];
    return rows.slice(-limit);
  }
};
