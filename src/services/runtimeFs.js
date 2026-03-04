import fs from 'fs';
import path from 'path';

const codeRoot = process.cwd();
const runtimeRoot = process.env.VERCEL ? '/tmp/secretary-runtime' : codeRoot;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyIfMissing(src, dest) {
  if (fs.existsSync(dest)) return;
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    fs.cpSync(src, dest, { recursive: true });
    return;
  }
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

export function ensureRuntimeSeeded() {
  ensureDir(runtimeRoot);
  if (!process.env.VERCEL) {
    copyIfMissing(path.join(codeRoot, 'data'), path.join(runtimeRoot, 'data'));
  }
  copyIfMissing(path.join(codeRoot, 'memory'), path.join(runtimeRoot, 'memory'));

  const statePath = path.join(runtimeRoot, 'data', 'state.json');
  if (!fs.existsSync(statePath)) {
    ensureDir(path.dirname(statePath));
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
  }
}

export function runtimePath(...parts) {
  return path.join(runtimeRoot, ...parts);
}

export function sourcePath(...parts) {
  return path.join(codeRoot, ...parts);
}

export function isEphemeralRuntime() {
  return Boolean(process.env.VERCEL);
}
