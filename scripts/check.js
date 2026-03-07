import fs from 'fs';

const required = [
  'src/index.js',
  'src/app.js',
  'src/config.js',
  'src/services/lineClient.js',
  'src/services/assistantEngine.js',
  'src/services/scheduler.js',
  'src/services/googleDriveState.js',
  'src/services/googleTasksSync.js'
];

const missing = required.filter((f) => !fs.existsSync(f));
if (missing.length) {
  console.error('Missing files:', missing.join(', '));
  process.exit(1);
}

console.log('check ok');
