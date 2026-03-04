import fs from 'fs';
import path from 'path';
import { store } from './store.js';
import { ensureRuntimeSeeded, runtimePath, sourcePath } from './runtimeFs.js';

ensureRuntimeSeeded();

const memoryRoot = runtimePath('memory');

function abs(relPath) {
  return path.join(memoryRoot, relPath);
}

function sourceAbs(relPath) {
  return sourcePath('memory', relPath);
}

function appendLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${line}\n`);
}

function safeRead(filePath, fallbackPath = null) {
  if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
  if (fallbackPath && fs.existsSync(fallbackPath)) return fs.readFileSync(fallbackPath, 'utf8');
  return '';
}

export function logConversationLine(date, line) {
  const p = abs(`40_logs/conversations/${date}.md`);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${date}\n\n`);
  }
  appendLine(p, line);
}

export function logDailyLine(date, line) {
  const p = abs(`40_logs/daily/${date}.md`);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `# ${date}\n\n`);
  }
  appendLine(p, line);
}

function writeWithRevision(relPath, after, reason, actor = 'user') {
  const p = abs(relPath);
  const before = safeRead(p, sourceAbs(relPath));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, after);
  const rev = store.addMemoryRevision({
    filePath: relPath,
    before,
    after,
    reason,
    actor
  });
  appendLine(abs('60_adaptation/CHANGELOG.md'), `- ${rev.id} ${new Date().toISOString()} ${relPath} :: ${reason}`);
  return rev;
}

export function appendMemoryFact(text, reason = 'remember', actor = 'user') {
  const relPath = 'MEMORY.md';
  const current = safeRead(abs(relPath), sourceAbs(relPath));
  const after = `${current.trimEnd()}\n- ${text}\n`;
  return writeWithRevision(relPath, after, reason, actor);
}

export function forgetMemoryFact(keyword, actor = 'user') {
  const relPath = 'MEMORY.md';
  const current = safeRead(abs(relPath), sourceAbs(relPath));
  const lines = current.split('\n');
  const filtered = lines.filter((l) => !l.includes(keyword));
  const after = filtered.join('\n').replace(/\n+$/, '\n');
  return writeWithRevision(relPath, after, `forget:${keyword}`, actor);
}

export function tuneRule(line, actor = 'user') {
  const relPath = '60_adaptation/USER_EDITABLE_RULES.md';
  const current = safeRead(abs(relPath), sourceAbs(relPath));
  const after = `${current.trimEnd()}\n- ${line}\n`;
  return writeWithRevision(relPath, after, `tune:${line}`, actor);
}

export function rollbackLastRevision(actor = 'user') {
  const [latest] = store.listMemoryRevisions(1);
  if (!latest) return null;
  const relPath = latest.filePath;
  const p = abs(relPath);
  const current = safeRead(p, sourceAbs(relPath));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, latest.before || '');
  const rev = store.addMemoryRevision({
    filePath: relPath,
    before: current,
    after: latest.before || '',
    reason: `rollback:${latest.id}`,
    actor
  });
  appendLine(abs('60_adaptation/CHANGELOG.md'), `- ${rev.id} ${new Date().toISOString()} ${relPath} :: rollback ${latest.id}`);
  return { rollbackOf: latest.id, revision: rev };
}

export function summarizeCoreMemory() {
  const files = [
    '00_core/USER_PROFILE.md',
    '00_core/TIME_PREFERENCES.md',
    '00_core/TASK_ESTIMATION_RULES.md',
    '60_adaptation/USER_EDITABLE_RULES.md',
    'MEMORY.md'
  ];
  return files
    .map((f) => `## ${f}\n${safeRead(abs(f), sourceAbs(f)).slice(0, 1500)}`)
    .join('\n\n');
}
